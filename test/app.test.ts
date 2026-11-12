import { describe, expect, it } from "vitest";
import { createApiHandler } from "@/http/app";
import { createLogger } from "@/core/logger";
import { createRoutes } from "@/routes";
import type { RouteDefinition } from "@/http/router";

function harness(options: { databaseUp?: boolean; allowed?: boolean } = {}) {
  const routes: RouteDefinition[] = createRoutes({
    checkDatabase: async () => options.databaseUp ?? true,
  });
  const logger = createLogger({ level: "debug", sink: () => undefined });
  const handler = createApiHandler(routes, {
    logger,
    limiter: {
      consume: async () =>
        options.allowed === false
          ? { allowed: false, retryAfterSeconds: 7, exceeded: "ip" as const }
          : { allowed: true, retryAfterSeconds: 0 },
    },
  });
  return handler;
}

const base = "http://localhost:3000/api";

describe("API pipeline", () => {
  it("serves a healthy GET /api/health", async () => {
    const response = await harness().call(null, new Request(`${base}/health`), ["health"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.database).toBe("up");
  });

  it("reports a degraded database with 503", async () => {
    const response = await harness({ databaseUp: false }).call(
      null,
      new Request(`${base}/health`),
      ["health"],
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("down");
  });

  it("echoes a safe request id", async () => {
    const response = await harness().call(
      null,
      new Request(`${base}/health`, { headers: { "x-request-id": "trace-1" } }),
      ["health"],
    );
    expect(response.headers.get("x-request-id")).toBe("trace-1");
  });

  it("returns a structured 404", async () => {
    const response = await harness().call(null, new Request(`${base}/missing`), ["missing"]);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBeTruthy();
  });

  it("returns 405 with an Allow header", async () => {
    const response = await harness().call(
      null,
      new Request(`${base}/health`, { method: "DELETE" }),
      ["health"],
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("returns 429 when the limiter denies", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        pattern: ["limited"],
        handler: async ({ requestId }) =>
          Response.json({ ok: true }, { headers: { "x-request-id": requestId } }),
        rateLimit: () => [{ kind: "ip", value: "127.0.0.1", limit: 1, windowSeconds: 60 }],
      },
    ];
    const handler = createApiHandler(routes, {
      logger: createLogger({ level: "error", sink: () => undefined }),
      limiter: {
        consume: async () => ({ allowed: false, retryAfterSeconds: 7, exceeded: "ip" as const }),
      },
    });
    const response = await handler.call(null, new Request(`${base}/limited`), ["limited"]);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("returns 503 when the limiter store fails closed", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        pattern: ["limited"],
        handler: async ({ requestId }) =>
          Response.json({ ok: true }, { headers: { "x-request-id": requestId } }),
        rateLimit: () => [{ kind: "ip", value: "127.0.0.1", limit: 1, windowSeconds: 60 }],
      },
    ];
    const handler = createApiHandler(routes, {
      logger: createLogger({ level: "error", sink: () => undefined }),
      limiter: {
        consume: async () => ({ allowed: false, retryAfterSeconds: 30, degraded: true }),
      },
    });
    const response = await handler.call(null, new Request(`${base}/limited`), ["limited"]);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("unavailable");
  });

  it("turns an unexpected throw into a safe 500", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        pattern: ["boom"],
        handler: async () => {
          throw new Error("database password leaked");
        },
      },
    ];
    const handler = createApiHandler(routes, {
      logger: createLogger({ level: "error", sink: () => undefined }),
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    });
    const response = await handler.call(null, new Request(`${base}/boom`), ["boom"]);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("password leaked");
  });

  it("rejects an unsafe request without an allowlisted origin", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "POST",
        pattern: ["mutate"],
        csrf: true,
        handler: async ({ requestId }) =>
          Response.json({ ok: true }, { headers: { "x-request-id": requestId } }),
      },
    ];
    const handler = createApiHandler(routes, {
      logger: createLogger({ level: "error", sink: () => undefined }),
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      csrfOrigins: ["https://hub.example"],
    });
    const blocked = await handler.call(
      null,
      new Request(`${base}/mutate`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      ["mutate"],
    );
    expect(blocked.status).toBe(403);

    const allowed = await handler.call(
      null,
      new Request(`${base}/mutate`, { method: "POST", headers: { origin: "https://hub.example" } }),
      ["mutate"],
    );
    expect(allowed.status).toBe(200);
  });

  it("injects the resolved session into the handler context", async () => {
    const routes: RouteDefinition[] = [
      {
        method: "GET",
        pattern: ["me"],
        handler: async ({ requestId, session }) =>
          Response.json({ session }, { headers: { "x-request-id": requestId } }),
      },
    ];
    const handler = createApiHandler(routes, {
      logger: createLogger({ level: "error", sink: () => undefined }),
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      resolveSession: async () => ({ userId: "user_1", roles: ["user"] }),
    });
    const response = await handler.call(null, new Request(`${base}/me`), ["me"]);
    expect(await response.json()).toEqual({ session: { userId: "user_1", roles: ["user"] } });
  });
});
