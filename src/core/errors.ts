/**
 * A single error surface for the whole API. Internal reasons never reach the
 * client; they belong in structured logs keyed by the request ID.
 */

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "payload_too_large"
  | "rate_limited"
  | "unavailable"
  | "idempotency_conflict"
  | "invalid_key"
  | "expired_key"
  | "revoked_key"
  | "banned_key"
  | "suspended_key"
  | "already_owned"
  | "hwid_missing"
  | "reactivation_not_authorized"
  | "hwid_mismatch"
  | "session_required"
  | "session_expired"
  | "session_revoked"
  | "not_owner"
  | "not_authorized"
  | "hwid_reset_cooldown"
  | "hwid_reset_limit_reached"
  | "key_not_active"
  | "replay_detected"
  | "internal_error";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { expose?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.expose = options.expose ?? status < 500;
    this.details = options.details;
  }
}

export const badRequest = (message = "Invalid request", details?: Record<string, unknown>) =>
  new AppError("bad_request", 400, message, { details });

export const unauthorized = (message = "Authentication required") =>
  new AppError("unauthorized", 401, message);

export const forbidden = (message = "Not permitted") => new AppError("forbidden", 403, message);

export const notFound = (message = "Not found") => new AppError("not_found", 404, message);

export const methodNotAllowed = (
  message = "Method not allowed",
  details?: Record<string, unknown>,
) => new AppError("method_not_allowed", 405, message, { details });

export const conflict = (message = "Conflict", details?: Record<string, unknown>) =>
  new AppError("conflict", 409, message, { details });

export const payloadTooLarge = (message = "Payload too large") =>
  new AppError("payload_too_large", 413, message);

export const rateLimited = (message = "Too many requests", details?: Record<string, unknown>) =>
  new AppError("rate_limited", 429, message, { details });

export const serviceUnavailable = (
  message = "Service temporarily unavailable",
  details?: Record<string, unknown>,
) => new AppError("unavailable", 503, message, { details });

export const idempotencyConflict = (message = "Idempotency key reused with a different request") =>
  new AppError("idempotency_conflict", 409, message);

export const internalError = (cause?: unknown) =>
  new AppError("internal_error", 500, "Internal server error", { cause, expose: false });

export interface ErrorBody {
  error: {
    code: ErrorCode | "unknown";
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function toErrorBody(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.expose ? error.message : "Internal server error",
          requestId,
          ...(error.expose && error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: "unknown", message: "Internal server error", requestId } },
  };
}
