import type { PoolClient } from "pg";
import type { Transaction } from "kysely";
import { getPool } from "@/db/pool";
import { getDb, type Database } from "@/db/kysely";

/**
 * Transaction helpers (D8). One place owns BEGIN/COMMIT/ROLLBACK and one place
 * sets statement-level timeouts. Feature code must not manage transactions
 * itself.
 */

export async function withPgTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Typed transaction for Kysely query construction. */
export async function withTransaction<T>(
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return getDb().transaction().execute(fn);
}
