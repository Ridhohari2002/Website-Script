import {
  AppError,
  forbidden,
  internalError,
  methodNotAllowed,
  notFound,
  toErrorBody,
  unauthorized,
} from "@/core/errors";
import { loadEnv } from "@/core/env";
import { logger as rootLogger, type Logger } from "@/core/logger";
import { resolveRequestId } from "@/core/request-id";
import { jsonResponse, responseClearsCookie } from "@/core/response";
import { PostgresRateLimiter, type RateLimitDecision } from "@/db/rate-limit-store";
import { SESSION_COOKIE } from "@/modules/auth/config";
import { hasAdminAccess } from "@/modules/auth/permissions";
import { assertCsrfToken, assertSameOrigin, allowedOrigins, isSafeMethod } from "@/middleware/csrf";
import { anonymousSession, type SessionResolver } from "@/middleware/session";
import { matchRoute, type RouteContext, type RouteDefinition } from "@/http/router";

/**
 * One request pipeline: tracing, routing, access level, CSRF, optional rate
 * limiting, session resolution, one error surface, and structured access logs.
 * Route files only translate HTTP.
 */

export interface AuthorizationDenialEvent {
  userId: string;
  roles: string[];
  method: string;
  path: string;
  requestId: string;
}

export interface ApiDependencies {
  logger?: Logger;
  limiter?: { consume: PostgresRateLimiter["consume"] };
  resolveSession?: SessionResolver;
  /** Overrides the origin allowlist derived from APP_URL. */
  csrfOrigins?: readonly string[];
  /** Durable audit hook for authenticated requests denied by the pipeline. */
  auditDenial?: (event: AuthorizationDenialEvent) => Promise<void> | void;
}

export function createApiHandler(
  routes: readonly RouteDefinition[],
  dependencies: ApiDependencies = {},
): (request: Request, path: readonly string[]) => Promise<Response> {
  const logger = dependencies.logger ?? rootLogger;
  const limiter = dependencies.limiter ?? new PostgresRateLimiter();
  const resolveSession = dependencies.resolveSession ?? anonymousSession;

  return async function handle(request, path) {
    const startedAt = Date.now();
    const requestId = resolveRequestId(request.headers);
    const requestLogger = logger.child({ requestId });
    const url = new URL(request.url);

    let status = 500;
    let response: Response;

    try {
      const match = matchRoute(routes, request.method, path);

      if (match.kind === "not_found") {
        throw notFound(`No route for ${url.pathname}`);
      }
      if (match.kind === "method_not_allowed") {
        response = errorResponse(
          methodNotAllowed("Method not allowed", { allowed: match.allowed }),
          requestId,
          { allow: match.allowed.join(", ") },
        );
        status = response.status;
        return response;
      }

      const context: RouteContext = {
        request,
        requestId,
        params: match.params,
        logger: requestLogger,
        session: await resolveSession(request),
      };

      const requiresSession = match.route.access === "user" || match.route.access === "admin";
      const unsafe = !isSafeMethod(request.method);

      if (requiresSession) {
        if (!context.session) throw unauthorized("Authentication required");
        if (match.route.access === "admin" && !hasAdminAccess(context.session.roles)) {
          if (dependencies.auditDenial) {
            try {
              await dependencies.auditDenial({
                userId: context.session.userId,
                roles: context.session.roles,
                method: request.method,
                path: url.pathname,
                requestId,
              });
            } catch (auditError) {
              requestLogger.error("authorization denial audit failed", {
                event: "auth.audit_failed",
                error: auditError instanceof Error ? auditError.message : String(auditError),
              });
            }
          }
          throw forbidden("Admin role required");
        }
      }

      if (match.route.csrf || (requiresSession && unsafe)) {
        const origins = dependencies.csrfOrigins ?? allowedOrigins(loadEnv().APP_URL);
        assertSameOrigin(request, origins);
      }

      if (requiresSession && unsafe) {
        assertCsrfToken(request, context.session);
      }

      if (match.route.rateLimit) {
        const decision = await limiter.consume(match.route.rateLimit(context));
        if (!decision.allowed) {
          response = rateLimitedResponse(decision, requestId);
          status = response.status;
          return response;
        }
      }

      response = await match.route.handler(context);
      applySessionCookies(response, context.session);
      status = response.status;
      return response;
    } catch (error) {
      const mapped = error instanceof AppError ? error : internalError(error);
      if (mapped.status >= 500) {
        requestLogger.error("request failed", {
          event: "request.error",
          method: request.method,
          path: url.pathname,
          code: mapped.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      response = errorResponse(mapped, requestId);
      status = response.status;
      return response;
    } finally {
      requestLogger.info("request completed", {
        event: "request.completed",
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Date.now() - startedAt,
      });
    }
  };
}

/**
 * Session cookies produced during resolution (rotation) are attached here so a
 * handler never has to know about cookie plumbing.
 *
 * If the handler cleared `bf_session` (logout, logout-all, self-revocation),
 * rotation cookies must be dropped. Appending a fresh token would leave a
 * live-looking cookie for a session that was just revoked.
 */
function applySessionCookies(response: Response, session: RouteContext["session"]): void {
  if (!session?.setCookies?.length) return;
  if (responseClearsCookie(response, SESSION_COOKIE)) return;
  for (const cookie of session.setCookies) {
    response.headers.append("set-cookie", cookie);
  }
}

function errorResponse(
  error: AppError,
  requestId: string,
  headers?: Record<string, string>,
): Response {
  const mapped = toErrorBody(error, requestId);
  return jsonResponse(mapped.body, { status: mapped.status, requestId, headers });
}

function rateLimitedResponse(decision: RateLimitDecision, requestId: string): Response {
  // A degraded deny means the store failed, not that the caller misbehaved.
  if (decision.degraded && !decision.exceeded) {
    return jsonResponse(
      {
        error: {
          code: "unavailable",
          message: "Service temporarily unavailable",
          requestId,
          details: { degraded: true },
        },
      },
      {
        status: 503,
        requestId,
        headers: { "retry-after": String(Math.max(1, decision.retryAfterSeconds)) },
      },
    );
  }

  return jsonResponse(
    {
      error: {
        code: "rate_limited",
        message: "Too many requests",
        requestId,
        ...(decision.degraded ? { details: { degraded: true } } : {}),
      },
    },
    {
      status: 429,
      requestId,
      headers: { "retry-after": String(Math.max(1, decision.retryAfterSeconds)) },
    },
  );
}
