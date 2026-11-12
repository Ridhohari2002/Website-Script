import type { Logger } from "@/core/logger";
import type { RateLimitDimension } from "@/db/rate-limit-store";
import type { SessionContext } from "@/middleware/session";

/** Everything a route handler needs. Handlers never read `process.env` directly. */
export interface RouteContext {
  request: Request;
  requestId: string;
  params: Record<string, string>;
  logger: Logger;
  session: SessionContext | null;
}

export type RouteHandler = (context: RouteContext) => Promise<Response> | Response;

export interface RouteDefinition {
  method: string;
  /** Path segments after `/api`, e.g. `["health"]`, `["keys", ":id"]`. */
  pattern: string[];
  handler: RouteHandler;
  /** When true, unsafe methods must carry an allowlisted Origin header. */
  csrf?: boolean;
  /**
   * Access level enforced by the pipeline before the handler runs.
   * Omitted means public. `user` and `admin` require a server-resolved session;
   * unsafe methods additionally require a valid CSRF token.
   */
  access?: "user" | "admin";
  /**
   * Optional rate-limit dimensions. A route without this function is never
   * throttled, which is deliberate: health checks must stay reachable.
   */
  rateLimit?: (context: RouteContext) => RateLimitDimension[];
}

export type RouteMatch =
  | { kind: "matched"; route: RouteDefinition; params: Record<string, string> }
  | { kind: "method_not_allowed"; allowed: string[] }
  | { kind: "not_found" };

/** Pure matcher so routing can be tested without a server. */
export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  segments: readonly string[],
): RouteMatch {
  const allowed = new Set<string>();
  for (const route of routes) {
    const params = matchPattern(route.pattern, segments);
    if (!params) continue;
    if (route.method !== method) {
      allowed.add(route.method);
      continue;
    }
    return { kind: "matched", route, params };
  }
  if (allowed.size > 0) {
    return { kind: "method_not_allowed", allowed: [...allowed].sort() };
  }
  return { kind: "not_found" };
}

function matchPattern(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index]!;
    const value = segments[index]!;
    if (part.startsWith(":")) {
      if (value.length === 0) return null;
      params[part.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (part !== value) return null;
  }
  return params;
}
