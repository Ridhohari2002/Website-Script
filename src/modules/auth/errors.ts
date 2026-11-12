/**
 * Auth failures that are safe to surface to a browser. They never carry a
 * provider response body, authorization code, token, or secret.
 */
export type AuthErrorCode =
  "invalid_state" | "oauth_failed" | "account_disabled" | "not_configured" | "session_required";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Present only when the failure is attributable to a known account. */
  readonly userId?: string;

  constructor(code: AuthErrorCode, message?: string, userId?: string) {
    super(message ?? code);
    this.name = "AuthError";
    this.code = code;
    this.userId = userId;
  }
}
