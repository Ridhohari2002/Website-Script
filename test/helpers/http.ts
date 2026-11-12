import { expect } from "vitest";
import { createLogger } from "@/core/logger";
import { jsonResponse } from "@/core/response";
import { createApiHandler } from "@/http/app";
import type { RouteDefinition } from "@/http/router";
import { CSRF_COOKIE, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import type { AuthService } from "@/modules/auth/service";
import type { KeyService } from "@/modules/keys/service";
import { createRoutes } from "@/routes";
import { cookieValue } from "./auth";

export const BASE = "http://localhost:3000";
export const ORIGIN = BASE;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type HttpHandler = ReturnType<typeof createHttpHarness>;

export function createHttpHarness(
  service: AuthService,
  options: { denyRateLimit?: boolean; keys?: KeyService } = {},
) {
  const routes: RouteDefinition[] = [
    ...createRoutes({
      auth: service,
      checkDatabase: async () => true,
      ...(options.keys ? { keys: options.keys } : {}),
    }),
    {
      method: "GET",
      pattern: ["admin", "ping"],
      access: "admin",
      handler: ({ requestId }) => jsonResponse({ ok: true }, { requestId }),
    },
  ];

  return createApiHandler(routes, {
    logger: createLogger({ level: "error", sink: () => undefined }),
    limiter: {
      consume: async () =>
        options.denyRateLimit
          ? { allowed: false, retryAfterSeconds: 5, exceeded: "ip" as const }
          : { allowed: true, retryAfterSeconds: 0 },
    },
    resolveSession: (request) => service.resolveSession(request),
    csrfOrigins: [ORIGIN],
    auditDenial: (event) => service.recordAuthorizationDenied(event),
  });
}

export interface LoginResult {
  cookie: string;
  csrf: string;
  session: string;
}

/** Full browser login through the HTTP pipeline. */
export async function performLogin(handler: HttpHandler): Promise<LoginResult> {
  const login = await handler.call(
    null,
    new Request(`${BASE}/api/auth/login?next=/dashboard`, {
      headers: { "user-agent": BROWSER_USER_AGENT },
    }),
    ["auth", "login"],
  );
  expect(login.status).toBe(302);
  const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE)!;

  const callback = await handler.call(
    null,
    new Request(`${BASE}/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}`, "user-agent": BROWSER_USER_AGENT },
    }),
    ["auth", "callback"],
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${BASE}/dashboard`);

  const cookies = callback.headers.getSetCookie();
  const session = cookieValue(cookies, SESSION_COOKIE);
  const csrf = cookieValue(cookies, CSRF_COOKIE);
  expect(session).toBeTruthy();
  expect(csrf).toBeTruthy();
  return { cookie: `${SESSION_COOKIE}=${session}`, csrf: csrf!, session: session! };
}

export async function listSessions(handler: HttpHandler, cookie: string): Promise<Response> {
  return handler.call(null, new Request(`${BASE}/api/auth/sessions`, { headers: { cookie } }), [
    "auth",
    "sessions",
  ]);
}
