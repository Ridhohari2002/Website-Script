/**
 * Session boundary for the request pipeline. Phase 1 shipped a resolver that
 * always returned null; Phase 2 supplies the server-side Discord session
 * resolver. The pipeline never trusts a session without this resolver.
 */
export interface SessionUser {
  id: string;
  discordId: string;
  username: string | null;
  avatarUrl: string | null;
}

export interface SessionContext {
  userId: string;
  roles: string[];
  sessionId?: string;
  /** Derived server-side from the session token hash. Never stored in the database. */
  csrfToken?: string;
  user?: SessionUser;
  expiresAt?: string;
  /** `Set-Cookie` lines produced during resolution, for example after rotation. */
  setCookies?: string[];
}

export type SessionResolver = (request: Request) => Promise<SessionContext | null>;

export const anonymousSession: SessionResolver = async () => null;
