import { describe, expect, it } from "vitest";
import { createLogger } from "@/core/logger";
import type { RateLimitDimension } from "@/db/rate-limit-store";
import { createApiHandler } from "@/http/app";
import type { RouteContext, RouteDefinition } from "@/http/router";
import type { AuthService } from "@/modules/auth/service";
import type { ExecutorService } from "@/modules/executor/service";
import type { KeyService } from "@/modules/keys/service";
import { authRoutes } from "@/routes/auth";
import { executorRoutes } from "@/routes/executor";
import { keyRoutes } from "@/routes/keys";
import { trustedProxyHeaders } from "./helpers/proxy";

const logger = createLogger({ level: "error", sink: () => undefined });

function context(
  headers: Record<string, string> = {},
  session: RouteContext["session"] = null,
): RouteContext {
  return {
    request: new Request("http://localhost:3000/api/auth/login", { headers }),
    requestId: "req-test",
    params: {},
    logger,
    session,
  };
}

function route(
  routes: readonly RouteDefinition[],
  method: string,
  pattern: string,
): RouteDefinition {
  const found = routes.find(
    (candidate) => candidate.method === method && candidate.pattern.join("/") === pattern,
  );
  expect(found?.rateLimit).toBeTypeOf("function");
  return found!;
}

function dimensions(
  routes: readonly RouteDefinition[],
  method: string,
  pattern: string,
  headers: Record<string, string> = {},
  session: RouteContext["session"] = null,
): RateLimitDimension[] {
  return route(routes, method, pattern).rateLimit!(context(headers, session));
}

describe("trusted proxy enforcement in production", () => {
  it("rejects a public rate-limited request with no verified IP", async () => {
    const service = {
      startLogin: async () => ({ location: "https://discord.example/oauth", cookies: [] }),
    } as unknown as AuthService;
    const handler = createApiHandler(authRoutes(service), {
      logger,
      production: true,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      resolveSession: async () => null,
    });

    const response = await handler.call(null, new Request("http://localhost:3000/api/auth/login"), [
      "auth",
      "login",
    ]);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("rejects a public request with an invalid proxy marker", async () => {
    let consumed = 0;
    const service = {
      startLogin: async () => ({ location: "https://discord.example/oauth", cookies: [] }),
    } as unknown as AuthService;
    const handler = createApiHandler(authRoutes(service), {
      logger,
      production: true,
      limiter: {
        consume: async () => {
          consumed += 1;
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
      resolveSession: async () => null,
    });

    const response = await handler.call(
      null,
      new Request("http://localhost:3000/api/auth/login", {
        headers: {
          "x-boyfinity-proxy-secret": "wrong-secret-value-0123456789",
          "x-forwarded-for": "203.0.113.10",
        },
      }),
      ["auth", "login"],
    );

    expect(response.status).toBe(403);
    expect(consumed).toBe(0);
  });

  it("still protects a request that has a non-IP server-derived dimension", async () => {
    const seen: RateLimitDimension[][] = [];
    const handler = createApiHandler(
      [
        {
          method: "GET",
          pattern: ["account"],
          rateLimit: () => [{ kind: "user", value: "user-1", limit: 10, windowSeconds: 60 }],
          handler: async ({ requestId }) =>
            Response.json({ ok: true }, { headers: { "x-request-id": requestId } }),
        },
      ],
      {
        logger,
        production: true,
        limiter: {
          consume: async (dimensions) => {
            seen.push(dimensions);
            return { allowed: true, retryAfterSeconds: 0 };
          },
        },
      },
    );

    const response = await handler.call(null, new Request("http://localhost:3000/api/account"), [
      "account",
    ]);

    expect(response.status).toBe(200);
    expect(seen).toEqual([[{ kind: "user", value: "user-1", limit: 10, windowSeconds: 60 }]]);
  });

  it("rejects an executor activation before any unknown-key lookup when IP is unverified", async () => {
    let handled = 0;
    const service = {
      activate: async () => {
        handled += 1;
        return {};
      },
    } as unknown as ExecutorService;
    const handler = createApiHandler(executorRoutes(service), {
      logger,
      production: true,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      resolveSession: async () => null,
    });

    const response = await handler.call(
      null,
      new Request("http://localhost:3000/api/executor/v1/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "unknown-key", hwid: "unknown-hwid", scriptId: "script-1" }),
      }),
      ["executor", "v1", "activate"],
    );

    expect(response.status).toBe(403);
    expect(handled).toBe(0);
  });

  it("serves a public request only after a verified IP is bucketed", async () => {
    const seen: RateLimitDimension[][] = [];
    const service = {
      startLogin: async () => ({ location: "https://discord.example/oauth", cookies: [] }),
    } as unknown as AuthService;
    const handler = createApiHandler(authRoutes(service), {
      logger,
      production: true,
      limiter: {
        consume: async (dimensions) => {
          seen.push(dimensions);
          return { allowed: true, retryAfterSeconds: 0 };
        },
      },
      resolveSession: async () => null,
    });

    const response = await handler.call(
      null,
      new Request("http://localhost:3000/api/auth/login", {
        headers: trustedProxyHeaders("203.0.113.10"),
        redirect: "manual",
      }),
      ["auth", "login"],
    );

    expect(response.status).toBe(302);
    expect(seen).toEqual([[{ kind: "ip", value: "203.0.113.10", limit: 20, windowSeconds: 300 }]]);
  });
});

describe("rate-limit dimensions without a verified IP", () => {
  const auth = authRoutes({} as AuthService);
  const executor = executorRoutes({} as ExecutorService);
  const keys = keyRoutes({} as KeyService);

  it("auth login and callback have no IP bucket and no unknown bucket", () => {
    for (const pattern of ["auth/login", "auth/callback"]) {
      const result = dimensions(auth, "GET", pattern);
      expect(result).toEqual([]);
      expect(result.some((dimension) => dimension.value === "unknown")).toBe(false);
    }
  });

  it("executor endpoints have no IP bucket and no unknown bucket", () => {
    for (const pattern of [
      "executor/v1/activate",
      "executor/v1/validate",
      "executor/v1/session/revoke",
    ]) {
      const result = dimensions(executor, "POST", pattern);
      expect(result).toEqual([]);
      expect(result.some((dimension) => dimension.value === "unknown")).toBe(false);
    }
  });

  it("does not trust x-real-ip on the executor route", () => {
    expect(
      dimensions(executor, "POST", "executor/v1/activate", {
        "x-real-ip": "198.51.100.7",
      }),
    ).toEqual([]);
  });

  it("keeps the server-derived user bucket on authenticated key endpoints", () => {
    const session = { userId: "user-1", roles: ["user"] };
    expect(dimensions(keys, "POST", "keys/activate", {}, session)).toEqual([
      { kind: "user", value: "user-1", limit: 10, windowSeconds: 60 },
    ]);
    expect(dimensions(keys, "POST", "keys/validate", {}, session)).toEqual([
      { kind: "user", value: "user-1", limit: 120, windowSeconds: 60 },
    ]);
  });

  it("adds the IP bucket only when the proxy marker is valid", () => {
    const session = { userId: "user-1", roles: ["user"] };
    expect(
      dimensions(keys, "POST", "keys/activate", trustedProxyHeaders("2001:db8::1"), session),
    ).toEqual([
      { kind: "user", value: "user-1", limit: 10, windowSeconds: 60 },
      { kind: "ip", value: "2001:db8::1", limit: 30, windowSeconds: 60 },
    ]);
  });
});
