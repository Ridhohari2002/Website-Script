import type { DbExecutor } from "@/db/client";
import { SESSION_METADATA_RETENTION_MS } from "@/modules/auth/config";
import { deleteExpiredOAuthStates } from "@/modules/auth/oauth-state-store";

export interface RetentionOptions {
  now?: Date;
  retentionMs?: number;
}

export interface RetentionResult {
  auditIpsRedacted: number;
  sessionMetadataRedacted: number;
  oauthStatesDeleted: number;
}

/**
 * Q9 retention: raw IP and user-agent values have a 30-day maximum lifetime.
 * Rows themselves are never deleted here — only the sensitive columns are
 * nulled — so audit history and session ids remain intact.
 */
export async function redactStaleAuditIps(
  db: DbExecutor,
  options: Required<RetentionOptions>,
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retentionMs);
  const result = await db.query(
    `update audit_logs
        set ip = null
      where ip is not null
        and created_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function redactStaleSessionMetadata(
  db: DbExecutor,
  options: Required<RetentionOptions>,
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retentionMs);
  const result = await db.query(
    `update sessions
        set ip = null, user_agent = null
      where (ip is not null or user_agent is not null)
        and created_at < $1`,
    [cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}

/**
 * Idempotent retention pass. Safe to run on a schedule: each statement only
 * touches rows past the cutoff, and expired/consumed OAuth states are removed
 * by the existing helper (including stored PKCE verifiers).
 */
export async function runAuthRetention(
  db: DbExecutor,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const resolved: Required<RetentionOptions> = {
    now: options.now ?? new Date(),
    retentionMs: options.retentionMs ?? SESSION_METADATA_RETENTION_MS,
  };

  const auditIpsRedacted = await redactStaleAuditIps(db, resolved);
  const sessionMetadataRedacted = await redactStaleSessionMetadata(db, resolved);
  const oauthStatesDeleted = await deleteExpiredOAuthStates(db, resolved.now);

  return { auditIpsRedacted, sessionMetadataRedacted, oauthStatesDeleted };
}
