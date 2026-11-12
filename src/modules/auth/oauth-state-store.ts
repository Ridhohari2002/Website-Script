import type { DbExecutor } from "@/db/client";

export interface CreateOAuthStateInput {
  stateHash: string;
  codeVerifier: string;
  redirectPath: string;
  now: Date;
  ttlMs: number;
}

export interface ConsumedOAuthState {
  id: string;
  codeVerifier: string | null;
  redirectPath: string | null;
  expiresAt: Date;
}

/**
 * OAuth state lifecycle. The state itself is stored only as a keyed hash.
 *
 * Consumption is a single conditional UPDATE, so two concurrent callbacks
 * carrying the same state cannot both succeed: the second sees `consumed_at`
 * already set and updates zero rows.
 */
export async function createOAuthState(
  db: DbExecutor,
  input: CreateOAuthStateInput,
): Promise<void> {
  const expiresAt = new Date(input.now.getTime() + input.ttlMs);
  await db.query(
    `insert into oauth_states (state_hash, code_verifier, redirect_path, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      input.stateHash,
      input.codeVerifier,
      input.redirectPath,
      input.now.toISOString(),
      expiresAt.toISOString(),
    ],
  );
}

export async function consumeOAuthState(
  db: DbExecutor,
  stateHash: string,
  now: Date,
): Promise<ConsumedOAuthState | null> {
  const result = await db.query<{
    id: string;
    code_verifier: string | null;
    redirect_path: string | null;
    expires_at: Date;
  }>(
    `update oauth_states
        set consumed_at = $2
      where state_hash = $1
        and consumed_at is null
        and expires_at > $2
      returning id, code_verifier, redirect_path, expires_at`,
    [stateHash, now.toISOString()],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    codeVerifier: row.code_verifier,
    redirectPath: row.redirect_path,
    expiresAt: row.expires_at,
  };
}

/** Cleanup helper for the scheduled job phase. Expired rows are never usable. */
export async function deleteExpiredOAuthStates(db: DbExecutor, now: Date): Promise<number> {
  const result = await db.query(
    "delete from oauth_states where expires_at <= $1 or consumed_at is not null",
    [now.toISOString()],
  );
  return result.rowCount ?? 0;
}
