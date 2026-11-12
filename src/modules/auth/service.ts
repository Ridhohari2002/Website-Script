import { loadEnv, getDiscordOwnerId, getSessionSecret, secureCookiesEnabled } from "@/core/env";
import { logger as rootLogger, type Logger } from "@/core/logger";
import { clientIp, userAgent } from "@/core/request-meta";
import type { Db } from "@/db/client";
import { getSqlDb } from "@/db/client";
import { constantTimeEqualString } from "@/db/hashing";
import {
  CSRF_COOKIE,
  DISCORD_SCOPES,
  MAX_ACTIVE_SESSIONS,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_ROTATE_AFTER_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "@/modules/auth/config";
import { clearCookie, readCookie, serializeCookie } from "@/modules/auth/cookies";
import {
  createCodeChallenge,
  createCodeVerifier,
  createOpaqueToken,
  deriveCsrfToken,
  hashOAuthState,
  hashSessionToken,
} from "@/modules/auth/crypto";
import { AuthError, type AuthErrorCode } from "@/modules/auth/errors";
import { writeAuditLog } from "@/modules/auth/audit";
import { describeUserAgent } from "@/modules/auth/device";
import { effectiveRoles } from "@/modules/auth/owner";
import { consumeOAuthState, createOAuthState } from "@/modules/auth/oauth-state-store";
import { absoluteRedirect, safeRedirectPath } from "@/modules/auth/redirect";
import {
  countActiveSessions,
  findSessionByTokenHash,
  insertSession,
  listActiveSessions,
  lockUserRowForSessionWrite,
  revokeAllSessionsForUser,
  revokeOldestActiveSessions,
  revokeOwnedSession,
  revokeSession,
  rotateSessionToken,
  touchSession,
} from "@/modules/auth/session-store";
import { ensureDefaultRole, isDiscordSnowflake, upsertUserByDiscordId } from "@/modules/auth/users";
import type { SessionContext } from "@/middleware/session";
import {
  buildAuthorizeUrl,
  createDiscordClient,
  type DiscordOAuthClient,
} from "@/providers/discord/client";
import { loadDiscordConfig, type DiscordOAuthConfig } from "@/providers/discord/config";

export interface SessionLifetimes {
  absoluteMs: number;
  idleMs: number;
  rotateAfterMs: number;
  touchIntervalMs: number;
  stateTtlMs: number;
}

const DEFAULT_LIFETIMES: SessionLifetimes = {
  absoluteMs: SESSION_ABSOLUTE_MS,
  idleMs: SESSION_IDLE_MS,
  rotateAfterMs: SESSION_ROTATE_AFTER_MS,
  touchIntervalMs: SESSION_TOUCH_INTERVAL_MS,
  stateTtlMs: OAUTH_STATE_TTL_MS,
};

export interface AuthServiceDeps {
  db?: Db;
  clock?: () => Date;
  discord?: DiscordOAuthClient;
  config?: DiscordOAuthConfig;
  logger?: Logger;
  sessionSecret?: string;
  secureCookies?: boolean;
  /** Omitted reads `DISCORD_OWNER_ID`; null explicitly disables owner derivation. */
  ownerDiscordId?: string | null;
  lifetimes?: Partial<SessionLifetimes>;
}

export interface StartLoginInput {
  next: string | null;
}

export interface StartLoginResult {
  location: string;
  cookies: string[];
}

export type CompleteLoginResult =
  | { ok: true; location: string; cookies: string[]; userId: string }
  | { ok: false; location: string; cookies: string[]; reason: AuthErrorCode };

export interface LogoutInput {
  session: SessionContext;
  request: Request;
}

export interface AuthorizationDenialInput {
  userId: string;
  roles: string[];
  method: string;
  path: string;
  requestId: string;
}

export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  absoluteExpiresAt: string | null;
  device: string;
}

export interface RevokeSessionInput {
  session: SessionContext;
  sessionId: string;
  request: Request;
}

export interface RevokeSessionResult {
  current: boolean;
  cookies: string[];
}

export interface AuthService {
  startLogin(input: StartLoginInput): Promise<StartLoginResult>;
  completeLogin(input: {
    request: Request;
    code: string | null;
    state: string | null;
    oauthError: string | null;
  }): Promise<CompleteLoginResult>;
  resolveSession(request: Request): Promise<SessionContext | null>;
  listSessions(input: { session: SessionContext }): Promise<SessionSummary[]>;
  revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult | null>;
  logout(input: LogoutInput): Promise<string[]>;
  logoutAll(input: LogoutInput): Promise<string[]>;
  recordAuthorizationDenied(input: AuthorizationDenialInput): Promise<void>;
}

/**
 * Phase 2 authentication service.
 *
 * Invariants:
 * - The browser never sees a Discord token; it is used once for /users/@me.
 * - Only a keyed hash of the session token is persisted.
 * - Every protected request re-reads the session row, so revocation is immediate.
 * - Roles are read from `user_roles` on every request, never from the client.
 */
export function createAuthService(deps: AuthServiceDeps = {}): AuthService {
  const lifetimes: SessionLifetimes = { ...DEFAULT_LIFETIMES, ...deps.lifetimes };
  const logger = deps.logger ?? rootLogger;
  let resolvedConfig: DiscordOAuthConfig | null = deps.config ?? null;
  let discordClient: DiscordOAuthClient | null = deps.discord ?? null;

  const db = (): Db => deps.db ?? getSqlDb();
  const clock = (): Date => (deps.clock ? deps.clock() : new Date());
  const secret = (): string => deps.sessionSecret ?? getSessionSecret();
  const ownerId = (): string | null =>
    deps.ownerDiscordId === undefined ? getDiscordOwnerId() : deps.ownerDiscordId;
  const secure = (): boolean => deps.secureCookies ?? secureCookiesEnabled();
  const appUrl = (): string => (deps.config ? deps.config.appUrl : loadEnv().APP_URL);

  function config(): DiscordOAuthConfig {
    if (!resolvedConfig) resolvedConfig = loadDiscordConfig();
    return resolvedConfig;
  }

  function discord(): DiscordOAuthClient {
    if (!discordClient) discordClient = createDiscordClient(config());
    return discordClient;
  }

  function idleExpiryFrom(at: Date, absoluteTime: number | null): Date {
    const idle = at.getTime() + lifetimes.idleMs;
    return new Date(absoluteTime === null ? idle : Math.min(idle, absoluteTime));
  }

  function sessionCookie(token: string): string {
    return serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secure(),
      sameSite: "Lax",
      path: "/",
      maxAgeSeconds: Math.floor(lifetimes.absoluteMs / 1000),
    });
  }

  function csrfCookie(token: string): string {
    return serializeCookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: secure(),
      sameSite: "Lax",
      path: "/",
      maxAgeSeconds: Math.floor(lifetimes.absoluteMs / 1000),
    });
  }

  function stateCookie(state: string): string {
    return serializeCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: secure(),
      sameSite: "Lax",
      path: "/api/auth",
      maxAgeSeconds: Math.floor(lifetimes.stateTtlMs / 1000),
    });
  }

  function clearStateCookie(): string {
    return clearCookie(OAUTH_STATE_COOKIE, { secure: secure(), path: "/api/auth" });
  }

  function clearSessionCookies(): string[] {
    return [
      clearCookie(SESSION_COOKIE, { secure: secure(), path: "/" }),
      clearCookie(CSRF_COOKIE, { secure: secure(), path: "/", httpOnly: false }),
    ];
  }

  async function safeAudit(event: Parameters<typeof writeAuditLog>[1]): Promise<void> {
    try {
      await writeAuditLog(db(), event);
    } catch (error) {
      logger.error("audit write failed", {
        event: "auth.audit_failed",
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function auditCallbackFailure(error: AuthError, request: Request): Promise<void> {
    logger.warn("authentication callback rejected", {
      event: "auth.callback_failed",
      reason: error.code,
    });
    if (error.code !== "account_disabled" || !error.userId) return;
    await safeAudit({
      actorUserId: error.userId,
      action: "auth.login_failed",
      targetType: "user",
      targetId: error.userId,
      metadata: { provider: "discord", reason: error.code },
      ip: clientIp(request),
    });
  }

  return {
    async startLogin({ next }) {
      const cfg = config();
      const now = clock();
      const state = createOpaqueToken();
      const verifier = createCodeVerifier();

      await createOAuthState(db(), {
        stateHash: hashOAuthState(state, secret()),
        codeVerifier: verifier,
        redirectPath: safeRedirectPath(next),
        now,
        ttlMs: lifetimes.stateTtlMs,
      });

      return {
        location: buildAuthorizeUrl({
          clientId: cfg.clientId,
          redirectUri: cfg.redirectUri,
          state,
          codeChallenge: createCodeChallenge(verifier),
          scopes: DISCORD_SCOPES,
        }),
        cookies: [stateCookie(state)],
      };
    },

    async completeLogin({ request, code, state, oauthError }) {
      const clearState = clearStateCookie();
      try {
        const cfg = config();
        if (oauthError) throw new AuthError("oauth_failed");

        const cookieState = readCookie(request, OAUTH_STATE_COOKIE);
        if (!code || !state || !cookieState || !constantTimeEqualString(cookieState, state)) {
          throw new AuthError("invalid_state");
        }

        const now = clock();
        const consumed = await consumeOAuthState(db(), hashOAuthState(state, secret()), now);
        if (!consumed || !consumed.codeVerifier) throw new AuthError("invalid_state");

        let profile;
        try {
          const tokens = await discord().exchangeCode({
            code,
            codeVerifier: consumed.codeVerifier,
            redirectUri: cfg.redirectUri,
          });
          profile = await discord().fetchProfile(tokens.accessToken);
        } catch {
          throw new AuthError("oauth_failed");
        }

        if (!isDiscordSnowflake(profile.id)) throw new AuthError("oauth_failed");

        const token = createOpaqueToken();
        const tokenHash = hashSessionToken(token, secret());
        const csrf = deriveCsrfToken(tokenHash, secret());
        const absoluteExpiresAt = new Date(now.getTime() + lifetimes.absoluteMs);
        const idleExpiresAt = idleExpiryFrom(now, absoluteExpiresAt.getTime());
        const ip = clientIp(request);
        const agent = userAgent(request);

        const { userId } = await db().transaction(async (tx) => {
          const user = await upsertUserByDiscordId(tx, profile, now);
          if (user.status !== "active") {
            throw new AuthError("account_disabled", "Account is not active", user.id);
          }
          await ensureDefaultRole(tx, { userId: user.id, now });

          // Serialize every login for this user before counting, so concurrent
          // logins cannot both observe a free slot (Q3 cap of five).
          await lockUserRowForSessionWrite(tx, user.id);
          const activeCount = await countActiveSessions(tx, { userId: user.id, now });
          const toRevoke = Math.max(0, activeCount + 1 - MAX_ACTIVE_SESSIONS);
          const revokedCount =
            toRevoke > 0
              ? await revokeOldestActiveSessions(tx, {
                  userId: user.id,
                  now,
                  count: toRevoke,
                })
              : 0;

          await insertSession(tx, {
            userId: user.id,
            tokenHash,
            userAgent: agent,
            ip,
            now,
            idleExpiresAt,
            absoluteExpiresAt,
          });
          await writeAuditLog(tx, {
            actorUserId: user.id,
            action: "auth.login",
            targetType: "user",
            targetId: user.id,
            metadata: { provider: "discord" },
            ip,
          });
          if (revokedCount > 0) {
            await writeAuditLog(tx, {
              actorUserId: user.id,
              action: "auth.session_limit_enforced",
              targetType: "user",
              targetId: user.id,
              metadata: { revokedSessions: revokedCount, maxSessions: MAX_ACTIVE_SESSIONS },
              ip,
            });
          }
          return { userId: user.id };
        });

        return {
          ok: true,
          location: absoluteRedirect(cfg.appUrl, consumed.redirectPath ?? "/"),
          cookies: [sessionCookie(token), csrfCookie(csrf), clearState],
          userId,
        };
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        await auditCallbackFailure(error, request);
        return {
          ok: false,
          location: absoluteRedirect(appUrl(), `/?auth_error=${error.code}`),
          cookies: [clearState],
          reason: error.code,
        };
      }
    },

    async resolveSession(request) {
      const rawToken = readCookie(request, SESSION_COOKIE);
      if (!rawToken) return null;

      const sessionSecret = secret();
      const tokenHash = hashSessionToken(rawToken, sessionSecret);
      const row = await findSessionByTokenHash(db(), tokenHash);
      if (!row) return null;

      const now = clock();
      if (row.revoked_at) return null;
      if (row.status !== "active") return null;
      if (row.expires_at.getTime() <= now.getTime()) return null;
      if (row.absolute_expires_at && row.absolute_expires_at.getTime() <= now.getTime()) {
        return null;
      }

      const absoluteTime = row.absolute_expires_at?.getTime() ?? null;
      const rotatedSince = row.rotated_at ?? row.created_at;
      const setCookies: string[] = [];
      // The CSRF token for this request is derived from the token the client
      // actually presented. A rotation replaces it for the next request via the
      // response cookies; deriving it from the new hash here would reject the
      // current request's synchronizer token.
      const requestCsrfToken = deriveCsrfToken(tokenHash, sessionSecret);

      if (now.getTime() - rotatedSince.getTime() >= lifetimes.rotateAfterMs) {
        const nextToken = createOpaqueToken();
        const nextHash = hashSessionToken(nextToken, sessionSecret);
        const rotated = await rotateSessionToken(db(), {
          id: row.id,
          currentTokenHash: tokenHash,
          nextTokenHash: nextHash,
          now,
          idleExpiresAt: idleExpiryFrom(now, absoluteTime),
        });
        if (rotated) {
          setCookies.push(
            sessionCookie(nextToken),
            csrfCookie(deriveCsrfToken(nextHash, sessionSecret)),
          );
        }
      } else if (now.getTime() - row.last_seen_at.getTime() >= lifetimes.touchIntervalMs) {
        await touchSession(db(), {
          id: row.id,
          now,
          idleExpiresAt: idleExpiryFrom(now, absoluteTime),
        });
      }

      return {
        userId: row.user_id,
        roles: effectiveRoles(row.roles, row.discord_id, ownerId()),
        sessionId: row.id,
        csrfToken: requestCsrfToken,
        user: {
          id: row.user_id,
          discordId: row.discord_id,
          username: row.username,
          avatarUrl: row.avatar_url,
        },
        expiresAt: row.expires_at.toISOString(),
        ...(setCookies.length > 0 ? { setCookies } : {}),
      };
    },

    async listSessions({ session }) {
      const now = clock();
      const rows = await listActiveSessions(db(), { userId: session.userId, now });
      return rows.map((row) => ({
        id: row.id,
        current: row.id === session.sessionId,
        createdAt: row.created_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        absoluteExpiresAt: row.absolute_expires_at?.toISOString() ?? null,
        device: describeUserAgent(row.user_agent),
      }));
    },

    async revokeSession({ session, sessionId, request }) {
      const revoked = await revokeOwnedSession(db(), {
        userId: session.userId,
        sessionId,
        now: clock(),
      });
      if (!revoked) return null;

      const current = sessionId === session.sessionId;
      await safeAudit({
        actorUserId: session.userId,
        action: "auth.session_revoked",
        targetType: "session",
        targetId: sessionId,
        metadata: { self: current },
        ip: clientIp(request),
      });
      return { current, cookies: current ? clearSessionCookies() : [] };
    },

    async logout({ session, request }) {
      if (!session.sessionId) throw new AuthError("session_required");
      await revokeSession(db(), { id: session.sessionId, now: clock() });
      await safeAudit({
        actorUserId: session.userId,
        action: "auth.logout",
        targetType: "session",
        targetId: session.sessionId,
        metadata: {},
        ip: clientIp(request),
      });
      return clearSessionCookies();
    },

    async logoutAll({ session, request }) {
      const count = await revokeAllSessionsForUser(db(), {
        userId: session.userId,
        now: clock(),
      });
      await safeAudit({
        actorUserId: session.userId,
        action: "auth.logout_all",
        targetType: "user",
        targetId: session.userId,
        metadata: { revokedSessions: count },
        ip: clientIp(request),
      });
      return clearSessionCookies();
    },

    async recordAuthorizationDenied(input) {
      await safeAudit({
        actorUserId: input.userId,
        action: "auth.authorization_denied",
        targetType: "route",
        targetId: input.path,
        metadata: {
          method: input.method,
          roles: input.roles,
          requestId: input.requestId,
        },
        ip: null,
      });
    },
  };
}
