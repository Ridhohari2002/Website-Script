import { loadLocalEnv, runMigrations } from "./migration-runner";
import { resolveSafeTestDatabase } from "./test-database-guard";

/**
 * Test-only migration runner. It reads only TEST_DATABASE_URL through the
 * shared safety guard and refuses anything but the dedicated concurrency
 * database. It never falls back to DATABASE_URL and never prints the connection
 * string.
 */

async function main(): Promise<void> {
  loadLocalEnv();
  const target = resolveSafeTestDatabase();
  await runMigrations({
    connectionString: target.connectionString,
    applicationName: "boyfinity-migrate-test",
    expectedDatabaseName: target.database,
    expectedUserName: target.user,
    log: (line) => console.log(line),
  });
  console.log(`done  test migrations checked`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
