import { describe, expect, it } from "vitest";
import { createLogger } from "@/core/logger";
import type { RouteContext } from "@/http/router";
import type { ExecutorService } from "@/modules/executor/service";
import { executorRoutes } from "@/routes/executor";

/**
 * The route-level bucket must be IP-only. Key and session buckets are applied
 * inside the executor service after a server-side hash lookup, so a spoofed or
 * rotating `x-key-fingerprint` header cannot pick a bucket.
 */

const logger = createLogger({ level: "error", sink: () => undefined });
const dummyService = {} as unknown as ExecutorService;
const routes = executorRoutes(dummyService);

function context(extraHeaders: Record<string, string> = {}): RouteContext {
  return {
    request: new Request("http://localhost:3000/api/executor/v1/activate", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "user-agent": "vitest",
        ...extraHeaders,
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
  it("limits activation by IP only", () => {
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
});
