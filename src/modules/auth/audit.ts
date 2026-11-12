import type { DbExecutor } from "@/db/client";

/**
 * Durable authentication audit trail. Metadata is limited to identifiers and
 * reason codes; tokens, authorization codes, and secrets never enter this table.
 */
export type AuthAuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.logout_all"
  | "auth.session_revoked"
  | "auth.session_limit_enforced"
  | "auth.authorization_denied";

export interface AuditEventInput {
  actorUserId: string | null;
  action: AuthAuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function writeAuditLog(db: DbExecutor, event: AuditEventInput): Promise<void> {
  await db.query(
    `insert into audit_logs (actor_user_id, action, target_type, target_id, metadata, ip)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      event.actorUserId,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.ip ?? null,
    ],
  );
}
