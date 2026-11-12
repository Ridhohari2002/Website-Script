import { Pool, type PoolConfig } from "pg";
import { getDatabaseUrl, loadEnv } from "@/core/env";

/**
 * One pool per process. Serverless instances each get their own pool; the pool
 * is created lazily so importing this module never opens a connection.
 */

let pool: Pool | null = null;

function buildConfig(connectionString: string, maxConnections: number): PoolConfig {
  return {
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "boyfinity-hub",
  };
}

export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool(buildConfig(getDatabaseUrl(), env.DATABASE_POOL_MAX));
    pool.on("error", (error) => {
      // A pool-level error must not crash the process; the request will surface it.
      console.error(
        JSON.stringify({ level: "error", message: "pg pool error", error: error.message }),
      );
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/** Test helper. Does not touch an existing pool. */
export function setPoolForTests(next: Pool | null): void {
  pool = next;
}
