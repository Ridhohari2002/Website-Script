import type { DbExecutor } from "@/db/client";

/**
 * Entitlement-aware access resolution.
 *
 * A key reaches a script only when all of the following hold:
 *   - the script exists, is published, enabled, and not deleted;
 *   - the key has an `active` entitlement for a product that is `active`;
 *   - that product maps the script through `product_scripts`;
 *   - the entitlement is inside its start/expiry window.
 *
 * There is deliberately no fallback that grants a valid key every published
 * script. Legacy keys receive a legacy entitlement, but the legacy product has
 * no script mapping until an owner explicitly adds one.
 */

export interface EligibleScript {
  scriptId: string;
  publicId: string;
  versionId: string | null;
}

export type ScriptAccessDenialCode =
  | "script_not_found"
  | "entitlement_missing"
  | "entitlement_expired"
  | "entitlement_suspended"
  | "product_inactive";

export type ScriptAccessResult =
  | {
      ok: true;
      script: EligibleScript;
      entitlementId: string;
      productId: string;
      grantExpiresAt: string | null;
    }
  | { ok: false; code: ScriptAccessDenialCode };

interface ScriptRow {
  scriptId: string;
  publicId: string;
  versionId: string | null;
}

interface EntitlementRow {
  id: string;
  product_id: string;
  status: string;
  starts_at: Date | string;
  expires_at: Date | string | null;
  product_active: boolean;
}

function asTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export async function resolveScriptAccess(
  db: DbExecutor,
  input: { keyId: string; publicId: string; now?: Date },
): Promise<ScriptAccessResult> {
  const now = input.now ?? new Date();

  const scriptResult = await db.query<ScriptRow>(
    `select s.id as "scriptId", s.public_id as "publicId", s.current_version_id as "versionId"
       from scripts s
      where s.public_id = $1
        and s.status = 'published'
        and s.enabled = true
        and s.deleted_at is null`,
    [input.publicId],
  );
  const script = scriptResult.rows[0];
  if (!script) return { ok: false, code: "script_not_found" };

  // Share-lock the entitlement rows so a concurrent revocation or suspension
  // cannot commit between this read and the grant. Every caller locks the key
  // row first; this lock is only ever taken after that, so entitlement writes
  // cannot invert the keys -> executor_sessions order.
  const entitlements = await db.query<EntitlementRow>(
    `select ke.id, ke.product_id, ke.status, ke.starts_at, ke.expires_at, p.active as product_active
       from key_entitlements ke
       join products p on p.id = ke.product_id
       join product_scripts ps on ps.product_id = ke.product_id and ps.script_id = $2
      where ke.key_id = $1
      order by ke.created_at desc, ke.id desc
      for share of ke`,
    [input.keyId, script.scriptId],
  );

  if (entitlements.rows.length === 0) return { ok: false, code: "entitlement_missing" };

  let sawInactiveProduct = false;
  let sawSuspended = false;
  let sawExpired = false;

  for (const row of entitlements.rows) {
    if (row.status === "suspended" || row.status === "revoked") {
      sawSuspended = true;
      continue;
    }
    if (!row.product_active) {
      sawInactiveProduct = true;
      continue;
    }
    if (row.status !== "active") {
      sawExpired = true;
      continue;
    }
    if (asTime(row.starts_at) > now.getTime()) {
      sawExpired = true;
      continue;
    }
    if (row.expires_at && asTime(row.expires_at) <= now.getTime()) {
      sawExpired = true;
      continue;
    }
    return {
      ok: true,
      script,
      entitlementId: row.id,
      productId: row.product_id,
      grantExpiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }

  if (sawSuspended) return { ok: false, code: "entitlement_suspended" };
  if (sawInactiveProduct) return { ok: false, code: "product_inactive" };
  if (sawExpired) return { ok: false, code: "entitlement_expired" };
  return { ok: false, code: "entitlement_missing" };
}
