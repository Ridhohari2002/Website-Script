/**
 * Fail-closed safety guard for test-only database access.
 *
 * Both the integration tests and the test migration runner resolve their
 * connection through this module. It never falls back to DATABASE_URL, rejects
 * ambiguous targets, and compares normalized connection identities so two
 * differently formatted URLs that point at the same database cannot slip
 * through.
 */

export const TEST_DATABASE_ENV = "TEST_DATABASE_URL";
export const TEST_DATABASE_NAME = "boyfinity_concurrency_test";
export const TEST_DATABASE_ALLOWLIST = [TEST_DATABASE_NAME] as const;

const DEFAULT_PORT = 5432;
const ALLOWED_SSL_MODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

const PRODUCTION_HOST_SEGMENTS = new Set(["prod", "production", "prd", "live"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export type TestDatabaseSafetyCode =
  | "missing_test_url"
  | "malformed_url"
  | "invalid_protocol"
  | "missing_identity"
  | "invalid_sslmode"
  | "unsafe_database_name"
  | "production_environment"
  | "production_host"
  | "unverifiable_database_url"
  | "unverifiable_app_url"
  | "same_as_application_database";

export class TestDatabaseSafetyError extends Error {
  readonly code: TestDatabaseSafetyCode;

  constructor(code: TestDatabaseSafetyCode, message: string) {
    super(message);
    this.name = "TestDatabaseSafetyError";
    this.code = code;
  }
}

export interface TestDatabaseTarget {
  /** Validated connection string. Never log or print this value. */
  connectionString: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: string | null;
}

interface ParsedConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: string | null;
}

function fail(code: TestDatabaseSafetyCode, message: string): never {
  throw new TestDatabaseSafetyError(code, message);
}

function normalizeHost(hostname: string): string {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, "");
  return lower.replace(/^\[(.*)\]$/, "$1");
}

function parseConnection(raw: string, label: string): ParsedConnection {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("malformed_url", `${label} is not a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return fail("invalid_protocol", `${label} must use the postgres: or postgresql: protocol.`);
  }

  const host = normalizeHost(parsed.hostname);
  const portText = parsed.port.trim();
  const port = portText === "" ? DEFAULT_PORT : Number(portText);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const user = decodeURIComponent(parsed.username);

  if (!host || !database || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
    return fail(
      "missing_identity",
      `${label} is missing a host, port, database, or username; refusing an ambiguous target.`,
    );
  }

  const sslModeRaw = parsed.searchParams.get("sslmode");
  const sslMode = sslModeRaw === null ? null : sslModeRaw.trim().toLowerCase();
  if (sslMode !== null && !ALLOWED_SSL_MODES.has(sslMode)) {
    return fail("invalid_sslmode", `${label} has an unsupported sslmode value.`);
  }

  return { host, port, database, user, sslMode };
}

function assertNotProductionHost(host: string, label: string): void {
  if (WILDCARD_HOSTS.has(host)) {
    return fail("production_host", `${label} uses a wildcard or unspecified host.`);
  }
  const segments = host.split(/[.\-_]/);
  if (segments.some((segment) => PRODUCTION_HOST_SEGMENTS.has(segment))) {
    return fail("production_host", `${label} host looks like a production host.`);
  }
}

function sameConnection(a: ParsedConnection, b: ParsedConnection): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolves TEST_DATABASE_URL or throws. DATABASE_URL and APP_URL are read only
 * for comparison; neither is ever used as a connection target.
 */
export function resolveSafeTestDatabase(
  source: NodeJS.ProcessEnv = process.env,
): TestDatabaseTarget {
  if (source.NODE_ENV === "production") {
    fail("production_environment", "Refusing test database access with NODE_ENV=production.");
  }

  const raw = source[TEST_DATABASE_ENV]?.trim();
  if (!raw) {
    fail("missing_test_url", `${TEST_DATABASE_ENV} is not set. Refusing test database access.`);
  }

  const target = parseConnection(raw, TEST_DATABASE_ENV);

  if (!(TEST_DATABASE_ALLOWLIST as readonly string[]).includes(target.database)) {
    fail(
      "unsafe_database_name",
      `Refusing test database access: database "${target.database}" is not in the test allowlist.`,
    );
  }

  assertNotProductionHost(target.host, TEST_DATABASE_ENV);

  const applicationUrl = source.DATABASE_URL?.trim();
  if (applicationUrl) {
    let application: ParsedConnection;
    try {
      application = parseConnection(applicationUrl, "DATABASE_URL");
    } catch (error) {
      if (error instanceof TestDatabaseSafetyError) {
        fail(
          "unverifiable_database_url",
          "DATABASE_URL is not a valid PostgreSQL URL; cannot verify the test database target.",
        );
      }
      throw error;
    }
    if (sameConnection(target, application)) {
      fail(
        "same_as_application_database",
        `Refusing test database access: ${TEST_DATABASE_ENV} targets the same database as DATABASE_URL.`,
      );
    }
  }

  const appUrl = source.APP_URL?.trim();
  if (appUrl) {
    let parsedApp: URL;
    try {
      parsedApp = new URL(appUrl);
    } catch {
      return fail(
        "unverifiable_app_url",
        "APP_URL is not a valid URL; cannot verify the test target.",
      );
    }
    const appHost = normalizeHost(parsedApp.hostname);
    if (parsedApp.protocol === "https:" && !isLoopback(appHost) && appHost === target.host) {
      fail(
        "production_host",
        `Refusing test database access: ${TEST_DATABASE_ENV} host matches the production APP_URL host.`,
      );
    }
  }

  return {
    connectionString: raw,
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    sslMode: target.sslMode,
  };
}
