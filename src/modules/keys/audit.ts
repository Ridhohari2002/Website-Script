import type { DbExecutor } from "@/db/client";

/**
 * Key lifecycle audit actions (BACKEND.md Section 8 names). Metadata is limited
 * to identifiers, fingerprints, and reason codes; plaintext keys and raw HWIDs
 * never enter this table.
 */
export type KeyAuditAction =
  | "key.generate"
  | "key.activate"
  | "key.activate_failed"
  | "key.validate"
  | "key.validate_failed"
  | "key.hwid_reset"
  | "key.hwid_reset_failed"
  | "key.hwid_reset_admin"
  | "key.hwid_reset_admin_failed"
  | "key.revoke"
  | "key.revoke_failed"
  | "key.ban_reactivation_consumed"
  | "executor.activate"
  | "executor.activate_failed"
  | "executor.validate"
  | "executor.validate_failed"
  | "executor.session_revoke"
  | "executor.session_revoke_failed"
  | "executor.session_revoke_admin";

export type AuditActorType = "user" | "admin" | "executor" | "system";

export interface KeyAuditEvent {
  actorUserId: string | null;
  action: KeyAuditAction;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  /** Distinguishes an executor request, which never carries a Discord user. */
  actorType?: AuditActorType;
  /** Non-user actor reference such as an executor session id or key id. */
  actorRef?: string | null;
}

export async function writeKeyAuditLog(db: DbExecutor, event: KeyAuditEvent): Promise<void> {
  await db.query(
    `insert into audit_logs
       (actor_user_id, action, target_type, target_id, metadata, ip, actor_type, actor_ref)
     values ($1, $2, 'key', $3, $4, $5, $6, $7)`,
    [
      event.actorUserId,
      event.action,
      event.targetId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.ip ?? null,
      event.actorType ?? (event.actorUserId ? "user" : "system"),
      event.actorRef ?? null,
    ],
  );
}
