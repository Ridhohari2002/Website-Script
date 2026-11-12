import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";
import { getPool } from "@/db/pool";

/**
 * Kysely is the typed query builder (D8). Database-specific operations use raw
 * SQL via the `sql` template. No module may create its own pool.
 */

export interface Database {
  // Tables are added as their owning phases land. Phase 1 uses raw SQL for
  // idempotency and rate limiting, so an empty table map is intentional.
  [table: string]: Record<string, unknown>;
}

let db: Kysely<Database> | null = null;

export function getDb(): Kysely<Database> {
  if (!db) {
    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: getPool() }),
    });
  }
  return db;
}

export function createDb(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await sql`select 1`.execute(getDb());
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (db) {
    const current = db;
    db = null;
    await current.destroy();
  }
}

export { sql };
