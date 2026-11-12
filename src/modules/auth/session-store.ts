import type { DbExecutor } from "@/db/client";

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  absolute_expires_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
  rotated_at: Date | null;
  discord_id: string;
  username: string | null;
  avatar_url: string | null;
  status: string;
  roles: string[] | null;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  now: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/**
 * Account session persistence. Only the caller-provided hash ever reaches this
 * table; no function here accepts or returns a plaintext session token.
 */
export async function insertSession(
  db: DbExecutor,
  input: CreateSessionInput,
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `insert into sessions
       (user_id, token_hash, user_agent, ip, expires_at, absolute_expires_at, last_seen_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)
     returning id`,
    [
      input.userId,
      input.tokenHash,
      input.userAgent,
      input.ip,
      input.idleExpiresAt.toISOString(),
      input.absoluteExpiresAt.toISOString(),
      input.now.toISOString(),
    ],
  );
  return { id: result.rows[0]!.id };
}

export async function findSessionByTokenHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `select s.id, s.user_id, s.token_hash, s.expires_at, s.absolute_expires_at, s.revoked_at,
            s.last_seen_at, s.created_at, s.rotated_at,
            u.discord_id, u.username, u.avatar_url, u.status,
            coalesce(array_agg(r.role) filter (where r.role is not null), '{}'::text[]) as roles
       from sessions s
       join users u on u.id = s.user_id
       left join user_roles r on r.user_id = u.id
      where s.token_hash = $1
      group by s.id, u.id`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Extends the idle window. Never resurrects a session that already expired. */
export async function touchSession(
  db: DbExecutor,
  input: { id: string; now: Date; idleExpiresAt: Date },
): Promise<void> {
  await db.query(
    `update sessions
        set last_seen_at = $2, expires_at = $3
      where id = $1 and revoked_at is null and expires_at > $2`,
    [input.id, input.now.toISOString(), input.idleExpiresAt.toISOString()],
  );
}

/**
 * Replaces the token hash in place. The old hash stops matching immediately,
 * which is the rotation guarantee. Returns null when another request rotated
 * first.
 */
export async function rotateSessionToken(
  db: DbExecutor,
  input: {
    id: string;
    currentTokenHash: string;
    nextTokenHash: string;
    now: Date;
    idleExpiresAt: Date;
  },
): Promise<boolean> {
  const result = await db.query(
    `update sessions
        set token_hash = $3, rotated_at = $4, last_seen_at = $4, expires_at = $5
      where id = $1 and token_hash = $2 and revoked_at is null
      returning id`,
    [
      input.id,
      input.currentTokenHash,
      input.nextTokenHash,
      input.now.toISOString(),
      input.idleExpiresAt.toISOString(),
    ],
  );
  return result.rows.length > 0;
}

export async function revokeSession(
  db: DbExecutor,
  input: { id: string; now: Date },
): Promise<boolean> {
  const result = await db.query(
    "update sessions set revoked_at = $2 where id = $1 and revoked_at is null returning id",
    [input.id, input.now.toISOString()],
  );
  return result.rows.length > 0;
}

export async function revokeAllSessionsForUser(
  db: DbExecutor,
  input: { userId: string; now: Date },
): Promise<number> {
  const result = await db.query(
    "update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null",
    [input.userId, input.now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export interface ActiveSessionRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date | null;
  user_agent: string | null;
}

/** Predicate shared by the cap, the listing, and eviction ordering. */
const ACTIVE_SESSION_FILTER = `revoked_at is null
  and expires_at > $2
  and (absolute_expires_at is null or absolute_expires_at > $2)`;

/**
 * Serializes logins for one user. Every session-creating path must take this
 * lock before counting, so two concurrent logins cannot both observe a free
 * slot. The upsert in the login transaction already locks the row; this call
 * makes the lock point explicit and refactor-safe.
 */
export async function lockUserRowForSessionWrite(db: DbExecutor, userId: string): Promise<void> {
  await db.query("select id from users where id = $1 for update", [userId]);
}

/** Sessions that can still authenticate: not revoked, not idle/absolute expired. */
export async function countActiveSessions(
  db: DbExecutor,
  input: { userId: string; now: Date },
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count
       from sessions
      where user_id = $1
        and ${ACTIVE_SESSION_FILTER}`,
    [input.userId, input.now.toISOString()],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Revokes the oldest active sessions (`created_at`, then `id`) so a new session
 * can be inserted without exceeding the cap. The new row does not exist yet,
 * so it can never be selected. Returns the number actually revoked; concurrent
 * logout may reduce it, which only makes the final count smaller.
 */
export async function revokeOldestActiveSessions(
  db: DbExecutor,
  input: { userId: string; now: Date; count: number },
): Promise<number> {
  if (input.count <= 0) return 0;
  const result = await db.query(
    `update sessions
        set revoked_at = $2
      where id in (
        select id
          from sessions
         where user_id = $1
           and ${ACTIVE_SESSION_FILTER}
         order by created_at asc, id asc
         limit $3
      )
      returning id`,
    [input.userId, input.now.toISOString(), input.count],
  );
  return result.rowCount ?? 0;
}

/** Active sessions owned by one user, most recently used first. */
export async function listActiveSessions(
  db: DbExecutor,
  input: { userId: string; now: Date },
): Promise<ActiveSessionRow[]> {
  const result = await db.query<ActiveSessionRow>(
    `select id, created_at, last_seen_at, expires_at, absolute_expires_at, user_agent
       from sessions
      where user_id = $1
        and ${ACTIVE_SESSION_FILTER}
      order by last_seen_at desc, id asc`,
    [input.userId, input.now.toISOString()],
  );
  return result.rows;
}

/**
 * Revokes one session only when it belongs to the caller and is still active.
 * Returns false for missing, foreign-owned, and already-revoked ids alike, so
 * the HTTP layer can answer with a uniform 404.
 */
export async function revokeOwnedSession(
  db: DbExecutor,
  input: { userId: string; sessionId: string; now: Date },
): Promise<boolean> {
  const result = await db.query(
    `update sessions
        set revoked_at = $3
      where id = $1
        and user_id = $2
        and revoked_at is null
      returning id`,
    [input.sessionId, input.userId, input.now.toISOString()],
  );
  return result.rows.length > 0;
}
