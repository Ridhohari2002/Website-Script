import { CSRF_COOKIE } from "@/modules/auth/config";
import { parseCookies } from "@/modules/auth/cookies";

/**
 * Client-side auth UI helpers.
 *
 * The session endpoint is the only source of navigation identity. Roles and
 * IDs are ignored here; authorization always happens on the server.
 */

export type AuthNavState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: { username: string | null; avatarUrl: string | null } }
  | { status: "unavailable" };

export type LogoutResult =
  | { ok: true; revoked: boolean }
  | { ok: false; reason: "missing-csrf" | "csrf" | "rejected" | "network" };

export type LogoutOutcome =
  { navigate: true; revoked: boolean } | { navigate: false; message: string };

/** The only avatar host the server ever builds URLs for. */
const DISCORD_AVATAR_HOST = "cdn.discordapp.com";

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Browser-side avatar policy. The session endpoint is trusted, but the image
 * source is still constrained to the Discord CDN host the server uses.
 */
export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.hostname !== DISCORD_AVATAR_HOST) return null;
  if (url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;

  return url.toString();
}

/** Narrows the `/api/auth/session` body without inventing fields. */
export function authStateFromPayload(payload: unknown): AuthNavState {
  if (!payload || typeof payload !== "object") return { status: "unavailable" };

  const user = (payload as { user?: unknown }).user;
  if (!user || typeof user !== "object") return { status: "unavailable" };

  const record = user as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return { status: "unavailable" };
  }

  return {
    status: "authenticated",
    user: {
      username: safeString(record.username),
      avatarUrl: safeAvatarUrl(record.avatarUrl),
    },
  };
}

/** One request per mount. No polling and no automatic retry loop. */
export async function loadAuthState(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AuthNavState> {
  try {
    const response = await fetcher("/api/auth/session", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });

    if (response.status === 401) return { status: "anonymous" };
    if (!response.ok) return { status: "unavailable" };

    return authStateFromPayload(await response.json());
  } catch {
    return { status: "unavailable" };
  }
}

/** `document.cookie` and a Cookie header share the same `name=value` format. */
export function readCsrfToken(cookieSource: string): string | null {
  return parseCookies(cookieSource)[CSRF_COOKIE] ?? null;
}

export interface LogoutDependencies {
  fetchImpl?: typeof fetch;
  cookieSource?: string;
}

/**
 * Posts the existing logout endpoint with the current CSRF cookie. The cookie
 * is read at call time so a token rotated by the session endpoint is not
 * replayed from stale memory.
 */
export async function submitLogout(dependencies: LogoutDependencies = {}): Promise<LogoutResult> {
  const cookieSource =
    dependencies.cookieSource ?? (typeof document === "undefined" ? "" : document.cookie);
  const csrfToken = readCsrfToken(cookieSource);
  if (!csrfToken) return { ok: false, reason: "missing-csrf" };

  try {
    const response = await (dependencies.fetchImpl ?? fetch)("/api/auth/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "x-csrf-token": csrfToken,
      },
    });

    if (response.status === 401) return { ok: true, revoked: false };
    if (response.status === 403) return { ok: false, reason: "csrf" };
    if (!response.ok) return { ok: false, reason: "rejected" };
    return { ok: true, revoked: true };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/**
 * Maps a logout result to the next UI action. A 401 means the request was
 * already unauthenticated; it is safe to reset the local UI, but it is not
 * evidence that this client caused server-side revocation.
 */
export function logoutOutcome(result: LogoutResult): LogoutOutcome {
  if (result.ok) return { navigate: true, revoked: result.revoked };

  switch (result.reason) {
    case "missing-csrf":
      return {
        navigate: false,
        message: "Session verification token is missing. Refresh the page and try again.",
      };
    case "csrf":
      return {
        navigate: false,
        message: "Security verification failed. Refresh the page and try again.",
      };
    case "network":
      return {
        navigate: false,
        message: "Logout could not be confirmed because the request failed. Try again.",
      };
    default:
      return { navigate: false, message: "Sign out failed. Try again." };
  }
}

/** Display-only label; control characters are removed and the value is bounded. */
export function accountLabel(username: string | null | undefined): string {
  const cleaned = (username ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 40);
  return cleaned || "Your account";
}
