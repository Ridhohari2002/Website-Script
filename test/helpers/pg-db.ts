import { Client, Pool } from "pg";
import type { Db, DbExecutor, QueryResult } from "@/db/client";
import {
  resolveSafeTestDatabase,
  TEST_DATABASE_ENV,
  TEST_DATABASE_NAME,
} from "../../scripts/test-database-guard";

/**
 * Real-PostgreSQL adapter for the concurrency integration tests.
 *
 * It deliberately does not use src/db/pool.ts or DATABASE_URL. Every connection
 * goes through the shared fail-closed test database guard, and the connected
 * database and role are verified before the adapter is used.
 */

export const CONCURRENCY_TEST_DATABASE_ENV = TEST_DATABASE_ENV;
export const CONCURRENCY_TEST_DATABASE_NAME = TEST_DATABASE_NAME;
export const TEST_SERVICE_APPLICATION_NAME = "boyfinity-concurrency-test";

const POOL_MAX = 12;

export interface PgTestDatabase {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

export interface PgTestDatabaseOptions {
  applicationName?: string;
}

export function requireConcurrencyTestDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  return resolveSafeTestDatabase(source).connectionString;
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

interface SessionIdentityRow {
  database: string;
  user: string;
}

async function verifyConnectedTarget(
  connectedDatabase: string,
  connectedUser: string,
  expectedDatabase: string,
  expectedUser: string,
): Promise<void> {
  if (connectedDatabase !== expectedDatabase) {
    throw new Error("Refusing test database access: connected database does not match the guard.");
  }
  if (connectedUser !== expectedUser) {
    throw new Error("Refusing test database access: connected role does not match the guard.");
  }
}

/**
 * Opens, validates, and returns a dedicated pool. No test write happens before
 * the guard accepts the target and the connected database and role are checked.
 */
export async function createPgTestDatabase(
  options: PgTestDatabaseOptions = {},
): Promise<PgTestDatabase> {
  const target = resolveSafeTestDatabase();
  const pool = new Pool({
    connectionString: target.connectionString,
    max: POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: options.applicationName ?? TEST_SERVICE_APPLICATION_NAME,
  });
  // Cleanup terminates lingering test backends; an idle client error must not
  // become an unhandled 'error' event that crashes the worker.
  pool.on("error", () => undefined);

  try {
    const current = await pool.query<SessionIdentityRow>(
      "select current_database() as database, current_user as user",
    );
    const row = current.rows[0];
    if (!row) throw new Error("Refusing test database access: could not verify the connection.");
    await verifyConnectedTarget(row.database, row.user, target.database, target.user);
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

/**
 * Opens a single verified client for lock blockers and controlled deadlock
 * reproduction. Callers own commit/rollback and end().
 */
export async function createPgTestClient(applicationName: string): Promise<Client> {
  const target = resolveSafeTestDatabase();
  const client = new Client({
    connectionString: target.connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 10_000,
  });
  // A forced termination during failure cleanup emits 'error'; without a
  // listener Node treats it as an uncaught exception.
  client.on("error", () => undefined);
  await client.connect();
  try {
    const current = await client.query<SessionIdentityRow>(
      "select current_database() as database, current_user as user",
    );
    const row = current.rows[0];
    if (!row) throw new Error("Refusing test database access: could not verify the connection.");
    await verifyConnectedTarget(row.database, row.user, target.database, target.user);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}
