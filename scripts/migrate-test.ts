import { loadLocalEnv, runMigrations } from "./migration-runner";

/**
 * Test-only migration runner. It reads only
 * BOYFINITY_CONCURRENCY_TEST_DATABASE_URL and refuses anything but the
 * dedicated concurrency database. It never falls back to DATABASE_URL and
 * never prints the connection string.
 */

const ENV_NAME = "BOYFINITY_CONCURRENCY_TEST_DATABASE_URL";
const DATABASE_NAME = "boyfinity_concurrency_test";

function requireTestDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source[ENV_NAME]?.trim();
  if (!raw) {
    throw new Error(`${ENV_NAME} is not set. Refusing to run test migrations.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${ENV_NAME} is not a valid URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${ENV_NAME} must use the postgres: or postgresql: protocol.`);
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (databaseName !== DATABASE_NAME) {
    throw new Error(
      `Refusing test migrations: database name must be "${DATABASE_NAME}", got "${databaseName}".`,
    );
  }

  const developmentUrl = source.DATABASE_URL?.trim();
  if (developmentUrl) {
    try {
      if (new URL(developmentUrl).toString() === parsed.toString()) {
        throw new Error(`Refusing test migrations: ${ENV_NAME} matches DATABASE_URL.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
      // An unparseable DATABASE_URL is irrelevant to this test-only command.
    }
  }

  return raw;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const connectionString = requireTestDatabaseUrl();
  await runMigrations({
    connectionString,
    applicationName: "boyfinity-migrate-test",
    expectedDatabaseName: DATABASE_NAME,
    log: (line) => console.log(line),
  });
  console.log(`done  test migrations checked`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
