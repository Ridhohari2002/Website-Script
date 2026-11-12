import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db, DbExecutor, QueryResult } from "@/db/client";

export interface TestDatabase {
  pglite: PGlite;
  db: Db;
  close(): Promise<void>;
}

interface RawQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
}

function wrap(executor: RawQueryable): DbExecutor {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<T>> {
      const result = await executor.query<T>(text, params ? [...params] : undefined);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
}

/** Embedded PostgreSQL with every reviewed migration applied, in order. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  const directory = join(process.cwd(), "supabase", "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await pglite.exec(await readFile(join(directory, file), "utf8"));
  }

  const db: Db = {
    ...wrap(pglite),
    transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return pglite.transaction(async (tx) => work(wrap(tx)));
    },
  };

  return { pglite, db, close: () => pglite.close() };
}
