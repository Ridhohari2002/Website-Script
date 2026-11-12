import type { DbExecutor } from "@/db/client";
import { CSRF_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import { hashSessionToken } from "@/modules/auth/crypto";
import { findSessionByTokenHash } from "@/modules/auth/session-store";

/**
 * Read-only session resolution for Server Components.
 *
 * This path deliberately does not call `resolveSession()`: rendering a page
 * must never rotate tokens, extend the idle window, or write cookies. The auth
 * header separately requests `/api/auth/session`, which follows the normal
 * pipeline; that request counts as session activity and may touch or rotate
 * after the page has rendered.
 */

export interface PageSessionUser {
  id: string;
  discordId: string;
  username: string | null;
  avatarUrl: string | null;
}

export interface PageSession {
  userId: string;
  sessionId: string;
  user: PageSessionUser;
  roles: string[];
  /** Delivery hint for the client to echo in `x-csrf-token`; never a credential by itself. */
  csrfToken: string | null;
  expiresAt: string;
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export interface PageSessionLookupInput {
  sessionToken: string | null;
  csrfToken: string | null;
  db: DbExecutor;
  sessionSecret: string;
  now: Date;
}

/**
 * Pure lookup: hash the presented token, read the existing session row, then
 * apply the same revocation, status, idle-expiry, and absolute-expiry checks as
 * the API pipeline. A missing session and a missing user both resolve to null.
 */
export async function lookupPageSession(
  input: PageSessionLookupInput,
): Promise<PageSession | null> {
  if (!input.sessionToken) return null;

  const tokenHash = hashSessionToken(input.sessionToken, input.sessionSecret);
  const row = await findSessionByTokenHash(input.db, tokenHash);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.status !== "active") return null;
  if (row.expires_at.getTime() <= input.now.getTime()) return null;
  if (row.absolute_expires_at && row.absolute_expires_at.getTime() <= input.now.getTime()) {
    return null;
  }

  return {
    userId: row.user_id,
    sessionId: row.id,
    user: {
      id: row.user_id,
      discordId: row.discord_id,
      username: row.username,
      avatarUrl: row.avatar_url,
    },
    roles: row.roles ?? [],
    csrfToken: input.csrfToken,
    expiresAt: row.expires_at.toISOString(),
  };
}

/** Reads the two auth cookies from any Next.js-compatible cookie store. */
export async function readPageSession(
  cookieStore: CookieReader,
  dependencies: Omit<PageSessionLookupInput, "sessionToken" | "csrfToken">,
): Promise<PageSession | null> {
  return lookupPageSession({
    ...dependencies,
    sessionToken: cookieStore.get(SESSION_COOKIE)?.value ?? null,
    csrfToken: cookieStore.get(CSRF_COOKIE)?.value ?? null,
  });
}
