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
  | "key.ban_reactivation_consumed";

export interface KeyAuditEvent {
  actorUserId: string | null;
  action: KeyAuditAction;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function writeKeyAuditLog(db: DbExecutor, event: KeyAuditEvent): Promise<void> {
  await db.query(
    `insert into audit_logs (actor_user_id, action, target_type, target_id, metadata, ip)
     values ($1, $2, 'key', $3, $4, $5)`,
    [
      event.actorUserId,
      event.action,
      event.targetId ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.ip ?? null,
    ],
  );
}
