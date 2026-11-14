import { describe, expect, it } from "vitest";
import { createLogger } from "@/core/logger";
import type { RouteContext } from "@/http/router";
import type { ExecutorService } from "@/modules/executor/service";
import { executorRoutes } from "@/routes/executor";
import { trustedProxyHeaders } from "./helpers/proxy";

/**
 * The route-level bucket must be IP-only and must only trust an IP proven by
 * the configured proxy marker. Key and session buckets are applied inside the
 * executor service after a server-side hash lookup, so a spoofed or rotating
 * `x-key-fingerprint` header cannot pick a bucket.
 */

const logger = createLogger({ level: "error", sink: () => undefined });
const dummyService = {} as unknown as ExecutorService;
const routes = executorRoutes(dummyService);

function context(headers: Record<string, string> = {}): RouteContext {
  return {
    request: new Request("http://localhost:3000/api/executor/v1/activate", {
      method: "POST",
      headers: {
        ...trustedProxyHeaders("203.0.113.10"),
        "user-agent": "vitest",
        ...headers,
      },
    }),
    requestId: "req-test",
    params: {},
    logger,
    session: null,
  };
}

function activateLimit(contextValue: RouteContext) {
  const route = routes.find(
    (candidate) =>
      candidate.method === "POST" && candidate.pattern.join("/") === "executor/v1/activate",
  );
  expect(route?.rateLimit).toBeTypeOf("function");
  return route!.rateLimit!(contextValue);
}

describe("executor route trust boundary", () => {
  it("limits activation by the verified proxy IP only", () => {
    expect(activateLimit(context())).toEqual([
      { kind: "ip", value: "203.0.113.10", limit: 20, windowSeconds: 60 },
    ]);
  });

  it("ignores a spoofed x-key-fingerprint header", () => {
    const without = activateLimit(context());
    const spoofed = activateLimit(
      context({
        "x-key-fingerprint": "attacker-controlled-bucket",
        authorization: "Bearer attacker-controlled-token",
      }),
    );
    expect(spoofed).toEqual(without);
    expect(spoofed.some((dimension) => dimension.kind === "key")).toBe(false);
  });

  it("omits the IP bucket when the proxy marker is missing", () => {
    expect(
      activateLimit(context({ "x-boyfinity-proxy-secret": "", "x-forwarded-for": "198.51.100.7" })),
    ).toEqual([]);
  });

  it("does not trust x-real-ip, even with a valid marker", () => {
    expect(
      activateLimit(
        context({
          "x-forwarded-for": "",
          "x-real-ip": "198.51.100.7",
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a forwarded list instead of selecting a client-controlled entry", () => {
    expect(activateLimit(context({ "x-forwarded-for": "203.0.113.10, 198.51.100.7" }))).toEqual([]);
  });

  it("supports a verified IPv6 address", () => {
    expect(activateLimit(context(trustedProxyHeaders("2001:db8::1")))).toEqual([
      { kind: "ip", value: "2001:db8::1", limit: 20, windowSeconds: 60 },
    ]);
  });
});
