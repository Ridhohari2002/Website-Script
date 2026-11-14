import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { createLogger } from "@/core/logger";
import { createApiHandler } from "@/http/app";
import type { RouteDefinition } from "@/http/router";

const ENV_KEYS = [
  "NODE_ENV",
  "RATE_LIMIT_HMAC_SECRET",
  "KEY_HMAC_SECRET",
  "TRUSTED_PROXY_SECRET",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
}

const routes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: ["probe"],
    handler: async ({ requestId }) =>
      Response.json({ ok: true }, { headers: { "x-request-id": requestId } }),
  },
];

afterEach(() => {
  resetEnvCache();
});

describe("production environment resolution in the request pipeline", () => {
  it("maps invalid production configuration to a safe error without running the handler", async () => {
    const previous = snapshotEnv();
    const canary = "leak-canary";
    const lines: string[] = [];
    let handled = 0;
    try {
      Object.assign(process.env, { NODE_ENV: "production" });
      process.env.RATE_LIMIT_HMAC_SECRET = "a-sufficiently-long-secret-value";
      process.env.KEY_HMAC_SECRET = "a-sufficiently-long-key-secret-value";
      process.env.TRUSTED_PROXY_SECRET = canary;
      resetEnvCache();

      const handler = createApiHandler(
        [
          {
            ...routes[0]!,
            handler: async ({ requestId }) => {
              handled += 1;
              return Response.json({ ok: true }, { headers: { "x-request-id": requestId } });
            },
          },
        ],
        {
          logger: createLogger({ level: "error", sink: (line) => lines.push(line) }),
          limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
        },
      );

      const response = await handler.call(null, new Request("http://localhost:3000/api/probe"), [
        "probe",
      ]);
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(handled).toBe(0);
      expect(body).toContain("Internal server error");
      expect(body).not.toContain(canary);
      expect(lines.join("\n")).not.toContain(canary);
    } finally {
      restoreEnv(previous);
      resetEnvCache();
    }
  });

  it("honors the production dependency override in both directions", async () => {
    const previous = snapshotEnv();
    try {
      Object.assign(process.env, { NODE_ENV: "production" });
      process.env.RATE_LIMIT_HMAC_SECRET = "a-sufficiently-long-secret-value";
      process.env.KEY_HMAC_SECRET = "a-sufficiently-long-key-secret-value";
      process.env.TRUSTED_PROXY_SECRET = "leak-canary";
      resetEnvCache();

      const limited: RouteDefinition[] = [
        {
          ...routes[0]!,
          rateLimit: () => [],
        },
      ];
      const productionHandler = createApiHandler(limited, {
        logger: createLogger({ level: "error", sink: () => undefined }),
        production: true,
        limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      });
      const blocked = await productionHandler.call(
        null,
        new Request("http://localhost:3000/api/probe"),
        ["probe"],
      );
      expect(blocked.status).toBe(403);

      const nonProductionHandler = createApiHandler(limited, {
        logger: createLogger({ level: "error", sink: () => undefined }),
        production: false,
        limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
      });
      const allowed = await nonProductionHandler.call(
        null,
        new Request("http://localhost:3000/api/probe"),
        ["probe"],
      );
      expect(allowed.status).toBe(200);
    } finally {
      restoreEnv(previous);
      resetEnvCache();
    }
  });
});
