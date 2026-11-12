import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { Client } from "pg";

/**
 * Forward-only migration runner shared by the normal and test-only scripts.
 * It records applied filenames in `schema_migrations` and never re-runs a file.
 * No down migrations: destructive changes need a reviewed script.
 */

export interface RunMigrationsOptions {
  connectionString: string;
  applicationName: string;
  /** When set, the connected database must match exactly before any write. */
  expectedDatabaseName?: string;
  migrationsDir?: string;
  log?: (line: string) => void;
}

export interface RunMigrationsResult {
  checked: number;
  applied: number;
}

export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      loadEnvFile(file);
      return;
    } catch {
      // Missing file is expected in CI; the real environment may supply the URL.
    }
  }
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = options.log ?? (() => undefined);
  const migrationsDir = options.migrationsDir ?? join(process.cwd(), "supabase", "migrations");
  const client = new Client({
    connectionString: options.connectionString,
    application_name: options.applicationName,
  });
  await client.connect();

  try {
    if (options.expectedDatabaseName) {
      const current = await client.query<{ name: string }>("select current_database() as name");
      const name = current.rows[0]?.name;
      if (name !== options.expectedDatabaseName) {
        throw new Error(
          `Refusing migrations: connected database "${name ?? "unknown"}" is not "${options.expectedDatabaseName}"`,
        );
      }
    }

    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    let applied = 0;

    for (const file of files) {
      const existing = await client.query<{ filename: string }>(
        "select filename from schema_migrations where filename = $1",
        [file],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        log(`skip  ${file}`);
        continue;
      }

      const sqlText = await readFile(join(migrationsDir, file), "utf8");
      log(`apply ${file}`);
      await client.query("begin");
      try {
        await client.query(sqlText);
        await client.query("insert into schema_migrations (filename) values ($1)", [file]);
        await client.query("commit");
        applied += 1;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    return { checked: files.length, applied };
  } finally {
    await client.end();
  }
}
