import { getDatabaseUrl } from "../src/core/env";
import { loadLocalEnv, runMigrations } from "./migration-runner";

/**
 * Minimal forward-only migration runner. It records applied filenames in
 * `schema_migrations` and refuses to re-run a file. No down migrations: this
 * project evolves forward, and destructive changes need a reviewed script.
 */

async function main(): Promise<void> {
  loadLocalEnv();
  const result = await runMigrations({
    connectionString: getDatabaseUrl(),
    applicationName: "boyfinity-migrate",
    log: (line) => console.log(line),
  });
  console.log(`done  ${result.checked} migration file(s) checked`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
