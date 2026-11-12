import { getPool } from "@/db/pool";

/**
 * Minimal SQL executor used by repositories.
 *
 * Repositories depend on this interface instead of the pg pool directly, so the
 * same code runs against PostgreSQL in production and against an embedded
 * PostgreSQL build in tests. Parameterized statements only; no string-built SQL.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export interface DbExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Db extends DbExecutor {
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

function createLazyPgDb(): Db {
  return {
    async query(text, params) {
      const result = await getPool().query(text, params ? [...params] : undefined);
      return { rows: result.rows as never[], rowCount: result.rowCount };
    },
    async transaction(work) {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const tx: DbExecutor = {
          async query(text, params) {
            const result = await client.query(text, params ? [...params] : undefined);
            return { rows: result.rows as never[], rowCount: result.rowCount };
          },
        };
        const output = await work(tx);
        await client.query("COMMIT");
        return output;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original failure is the useful one.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

let cached: Db | null = null;

/** One lazy wrapper per process. It never opens a connection on its own. */
export function getSqlDb(): Db {
  if (!cached) cached = createLazyPgDb();
  return cached;
}

/** Test helper. Not used by application code. */
export function setSqlDbForTests(next: Db | null): void {
  cached = next;
}
