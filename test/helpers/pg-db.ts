import { Pool } from "pg";
import type { Db, DbExecutor, QueryResult } from "@/db/client";

/**
 * Real-PostgreSQL adapter for the concurrency integration test.
 *
 * It deliberately does not use src/db/pool.ts or DATABASE_URL. The only
 * accepted connection string is BOYFINITY_CONCURRENCY_TEST_DATABASE_URL, and
 * the database name must be exactly `boyfinity_concurrency_test`.
 */

export const CONCURRENCY_TEST_DATABASE_ENV = "BOYFINITY_CONCURRENCY_TEST_DATABASE_URL";
export const CONCURRENCY_TEST_DATABASE_NAME = "boyfinity_concurrency_test";

const POOL_MAX = 12;

export interface PgTestDatabase {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export function requireConcurrencyTestDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source[CONCURRENCY_TEST_DATABASE_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${CONCURRENCY_TEST_DATABASE_ENV} is not set. Refusing to run the concurrency test.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${CONCURRENCY_TEST_DATABASE_ENV} is not a valid URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `${CONCURRENCY_TEST_DATABASE_ENV} must use the postgres: or postgresql: protocol.`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (databaseName !== CONCURRENCY_TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing concurrency test: database name must be "${CONCURRENCY_TEST_DATABASE_NAME}", got "${databaseName}".`,
    );
  }

  const developmentUrl = source.DATABASE_URL?.trim();
  if (developmentUrl) {
    try {
      if (new URL(developmentUrl).toString() === parsed.toString()) {
        throw new Error(
          `Refusing concurrency test: ${CONCURRENCY_TEST_DATABASE_ENV} matches DATABASE_URL.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
      // An unparseable DATABASE_URL is irrelevant to this isolated test.
    }
  }

  return raw;
}

function wrapPool(pool: Pool): Db {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: DbExecutor = {
          async query<Row = Record<string, unknown>>(
            text: string,
            params?: readonly unknown[],
          ): Promise<QueryResult<Row>> {
            const result = await client.query(text, params ? [...params] : undefined);
            return { rows: result.rows as Row[], rowCount: result.rowCount };
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

/**
 * Opens, validates, and returns a dedicated pool. No write happens before the
 * connected database name is confirmed.
 */
export async function createPgTestDatabase(): Promise<PgTestDatabase> {
  const connectionString = requireConcurrencyTestDatabaseUrl();
  const pool = new Pool({
    connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "boyfinity-concurrency-test",
  });

  try {
    const current = await pool.query<{ name: string }>("select current_database() as name");
    const name = current.rows[0]?.name;
    if (name !== CONCURRENCY_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing concurrency test: connected database "${name ?? "unknown"}" is not "${CONCURRENCY_TEST_DATABASE_NAME}".`,
      );
    }
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    db: wrapPool(pool),
    pool,
    close: () => pool.end(),
  };
}
