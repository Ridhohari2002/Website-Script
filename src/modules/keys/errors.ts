import { AppError, type ErrorCode } from "@/core/errors";

/**
 * Key lifecycle denials carry a stable machine code but a generic message, so a
 * caller cannot learn more than the code from a failure. The precise reason is
 * written to `audit_logs` by the service.
 */

type KeyDenialCode =
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
  | "timestamp_invalid"
  | "entitlement_missing"
  | "entitlement_expired"
  | "entitlement_suspended"
  | "product_inactive"
  | "script_not_found";

const UNAUTHORIZED_CODES: readonly KeyDenialCode[] = [
  "session_required",
  "session_expired",
  "session_revoked",
];

export function keyDenied(code: KeyDenialCode, message = "Key request denied"): AppError {
  const status = UNAUTHORIZED_CODES.includes(code) ? 401 : 403;
  return new AppError(code as ErrorCode, status, message);
}

export type { KeyDenialCode };
