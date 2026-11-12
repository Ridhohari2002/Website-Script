import { z } from "zod";
import { notFound, serviceUnavailable, unauthorized } from "@/core/errors";
import { clientIp } from "@/core/request-meta";
import { jsonResponse, redirectResponse } from "@/core/response";
import { validate } from "@/middleware/validation";
import { AuthError } from "@/modules/auth/errors";
import type { AuthService } from "@/modules/auth/service";
import type { RouteDefinition } from "@/http/router";

/**
 * Phase 2 authentication endpoints (BACKEND.md §9.1).
 *
 * `/auth/login` and `/auth/callback` are browser navigations, so failures are
 * reported as a redirect carrying a stable `auth_error` code. They never echo
 * the authorization code, provider body, or any credential.
 */

const AUTH_WINDOW_SECONDS = 300;
const LOGIN_IP_LIMIT = 20;
const CALLBACK_IP_LIMIT = 30;
const SESSION_ID = z.string().uuid();

export function authRoutes(service: AuthService): RouteDefinition[] {
  return [
    {
      method: "GET",
      pattern: ["auth", "login"],
      rateLimit: ({ request }) => [
        {
          kind: "ip",
          value: clientIp(request) ?? "unknown",
          limit: LOGIN_IP_LIMIT,
          windowSeconds: AUTH_WINDOW_SECONDS,
        },
      ],
      async handler({ request }) {
        const next = new URL(request.url).searchParams.get("next");
        try {
          const result = await service.startLogin({ next });
          return redirectResponse(result.location, result.cookies);
        } catch (error) {
          if (error instanceof AuthError && error.code === "not_configured") {
            throw serviceUnavailable("Authentication is not configured");
          }
          throw error;
        }
      },
    },
    {
      method: "GET",
      pattern: ["auth", "callback"],
      rateLimit: ({ request }) => [
        {
          kind: "ip",
          value: clientIp(request) ?? "unknown",
          limit: CALLBACK_IP_LIMIT,
          windowSeconds: AUTH_WINDOW_SECONDS,
        },
      ],
      async handler({ request }) {
        const url = new URL(request.url);
        const result = await service.completeLogin({
          request,
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          oauthError: url.searchParams.get("error"),
        });
        return redirectResponse(result.location, result.cookies);
      },
    },
    {
      method: "GET",
      pattern: ["auth", "session"],
      access: "user",
      handler({ session, requestId }) {
        if (!session) throw unauthorized("Authentication required");
        if (!session.user) throw unauthorized("Authentication required");
        return jsonResponse(
          {
            user: {
              id: session.user.id,
              discordId: session.user.discordId,
              username: session.user.username,
              avatarUrl: session.user.avatarUrl,
            },
            roles: session.roles,
            csrfToken: session.csrfToken ?? null,
            expiresAt: session.expiresAt ?? null,
          },
          { status: 200, requestId },
        );
      },
    },
    {
      method: "GET",
      pattern: ["auth", "sessions"],
      access: "user",
      async handler({ session, requestId }) {
        if (!session) throw unauthorized("Authentication required");
        const sessions = await service.listSessions({ session });
        return jsonResponse({ sessions }, { status: 200, requestId });
      },
    },
    {
      method: "DELETE",
      pattern: ["auth", "sessions", ":id"],
      access: "user",
      async handler({ session, params, request, requestId }) {
        if (!session) throw unauthorized("Authentication required");
        const sessionId = validate(SESSION_ID, params.id);
        const result = await service.revokeSession({ session, sessionId, request });
        if (!result) throw notFound("Session not found");
        return jsonResponse(
          { ok: true, current: result.current },
          { status: 200, requestId, cookies: result.cookies },
        );
      },
    },
    {
      method: "POST",
      pattern: ["auth", "logout"],
      access: "user",
      async handler({ session, request, requestId }) {
        if (!session) throw unauthorized("Authentication required");
        const cookies = await service.logout({ session, request });
        return jsonResponse({ ok: true }, { status: 200, requestId, cookies });
      },
    },
    {
      method: "POST",
      pattern: ["auth", "logout-all"],
      access: "user",
      async handler({ session, request, requestId }) {
        if (!session) throw unauthorized("Authentication required");
        const cookies = await service.logoutAll({ session, request });
        return jsonResponse({ ok: true }, { status: 200, requestId, cookies });
      },
    },
  ];
}
