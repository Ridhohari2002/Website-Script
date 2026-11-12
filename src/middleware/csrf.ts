import { forbidden } from "@/core/errors";
import { constantTimeEqualString } from "@/db/hashing";
import type { SessionContext } from "@/middleware/session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const CSRF_HEADER = "x-csrf-token";

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method);
}

/**
 * CSRF hook, Phase 1 scope: cookie-authenticated mutations must come from an
 * allowlisted origin.
 */
export function assertSameOrigin(request: Request, allowedOrigins: readonly string[]): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get("origin");
  if (!origin) throw forbidden("Origin header is required for this request");
  if (!allowedOrigins.includes(origin)) throw forbidden("Origin is not allowed");
}

/**
 * Phase 2 synchronizer token. The expected value is derived server-side from the
 * session token hash, so neither the CSRF cookie nor any client claim is
 * trusted. The browser only has to echo the value in `x-csrf-token`.
 */
export function assertCsrfToken(request: Request, session: SessionContext | null): void {
  if (!session?.csrfToken) throw forbidden("CSRF token required");
  const provided = request.headers.get(CSRF_HEADER);
  if (!provided || !constantTimeEqualString(provided, session.csrfToken)) {
    throw forbidden("CSRF token is missing or invalid");
  }
}

export function allowedOrigins(appUrl: string): string[] {
  try {
    return [new URL(appUrl).origin];
  } catch {
    return [];
  }
}
