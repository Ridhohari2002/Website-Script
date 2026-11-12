/**
 * Account session policy (IMPLEMENTATION_PLAN.md §5.3.7 Q6 recommendation).
 *
 * `expires_at` is the idle expiry: it is extended only after an activity check
 * passes. `absolute_expires_at` caps the total lifetime regardless of activity.
 * Both are checked on every protected request.
 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const SESSION_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

/** Owner-approved Q3 cap: the oldest active session is evicted on the sixth login. */
export const MAX_ACTIVE_SESSIONS = 5;

/** Q9: raw IP and user-agent metadata is redacted after 30 days, rows are kept. */
export const SESSION_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** OAuth state rows are short-lived and single-use. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const SESSION_COOKIE = "bf_session";
export const CSRF_COOKIE = "bf_csrf";
export const OAUTH_STATE_COOKIE = "bf_oauth_state";

/** Discord advertises `identify` only; no email scope is requested (Q5). */
export const DISCORD_SCOPES = ["identify"] as const;
