import type { DbExecutor } from "@/db/client";

/**
 * Phase 4 access orchestration: a key is only useful if the requested script is
 * eligible. Phase 3 catalog APIs are not present yet, so eligibility is read
 * directly from the reviewed `scripts` table by `public_id`.
 *
 * There is no plan/key-type-to-script mapping in the approved schema. Until
 * Phase 5 introduces one, every valid key may reach every published script.
 * That limitation is recorded in the Phase 4 implementation report.
 */

export interface EligibleScript {
  scriptId: string;
  publicId: string;
  versionId: string | null;
}

export async function resolveScriptAccess(
  db: DbExecutor,
  input: { publicId: string },
): Promise<EligibleScript | null> {
  const result = await db.query<EligibleScript>(
    `select s.id as "scriptId", s.public_id as "publicId", s.current_version_id as "versionId"
       from scripts s
      where s.public_id = $1
        and s.status = 'published'
        and s.enabled = true
        and s.deleted_at is null`,
    [input.publicId],
  );
  return result.rows[0] ?? null;
}
