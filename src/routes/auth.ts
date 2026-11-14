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

function ipDimensions(request: Request, limit: number) {
  const ip = clientIp(request);
  // No verified proxy marker means no trustworthy IP; omit the bucket instead
  // of pretending all clients share one identity.
  return ip ? [{ kind: "ip" as const, value: ip, limit, windowSeconds: AUTH_WINDOW_SECONDS }] : [];
}

export function authRoutes(service: AuthService): RouteDefinition[] {
  return [
    {
      method: "GET",
      pattern: ["auth", "login"],
      rateLimit: ({ request }) => ipDimensions(request, LOGIN_IP_LIMIT),
      async handler({ request, requestId }) {
        const next = new URL(request.url).searchParams.get("next");
        try {
          const result = await service.startLogin({ next });
          return redirectResponse(result.location, result.cookies, 302, requestId);
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
      rateLimit: ({ request }) => ipDimensions(request, CALLBACK_IP_LIMIT),
      async handler({ request, requestId }) {
        const url = new URL(request.url);
        const result = await service.completeLogin({
          request,
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          oauthError: url.searchParams.get("error"),
        });
        return redirectResponse(result.location, result.cookies, 302, requestId);
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
