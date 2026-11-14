import { describe, expect, it } from "vitest";
import {
  resolveSafeTestDatabase,
  TestDatabaseSafetyError,
  TEST_DATABASE_ENV,
  TEST_DATABASE_HOST_ALLOWLIST,
  TEST_DATABASE_NAME,
} from "../scripts/test-database-guard";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values } as NodeJS.ProcessEnv;
}

function expectSafetyCode(values: NodeJS.ProcessEnv, code: string): string {
  try {
    resolveSafeTestDatabase(values);
  } catch (error) {
    expect(error).toBeInstanceOf(TestDatabaseSafetyError);
    const safety = error as TestDatabaseSafetyError;
    expect(safety.code).toBe(code);
    return safety.message;
  }
  throw new Error("expected the safety guard to reject the target");
}

function testUrl(host: string, port?: number): string {
  const needsBrackets = host.includes(":") && !host.startsWith("[");
  const authorityHost = needsBrackets ? `[${host}]` : host;
  const authority = port === undefined ? authorityHost : `${authorityHost}:${port}`;
  return `postgresql://user:pass@${authority}/${TEST_DATABASE_NAME}`;
}

describe("test database safety guard", () => {
  it("fails closed when TEST_DATABASE_URL is absent", () => {
    const message = expectSafetyCode(env({}), "missing_test_url");
    expect(message).toContain(TEST_DATABASE_ENV);
  });

  it("rejects a malformed URL", () => {
    expectSafetyCode(env({ TEST_DATABASE_URL: "not-a-url" }), "malformed_url");
  });

  it("rejects a non-postgres protocol", () => {
    expectSafetyCode(
      env({ TEST_DATABASE_URL: "mysql://user:pass@localhost/boyfinity_concurrency_test" }),
      "invalid_protocol",
    );
  });

  it("rejects a database name outside the test allowlist", () => {
    expectSafetyCode(
      env({ TEST_DATABASE_URL: "postgresql://user:pass@localhost/boyfinity" }),
      "unsafe_database_name",
    );
    expectSafetyCode(
      env({ TEST_DATABASE_URL: "postgresql://user:pass@localhost/boyfinity_test" }),
      "unsafe_database_name",
    );
  });

  it("allows exactly the documented loopback hosts", () => {
    expect(TEST_DATABASE_HOST_ALLOWLIST).toEqual(["localhost", "127.0.0.1", "::1"]);
    for (const host of TEST_DATABASE_HOST_ALLOWLIST) {
      expect(resolveSafeTestDatabase(env({ TEST_DATABASE_URL: testUrl(host) })).host).toBe(host);
    }
  });

  it("normalizes IPv6 brackets and case when matching the host allowlist", () => {
    const bracketed = resolveSafeTestDatabase(env({ TEST_DATABASE_URL: testUrl("[::1]", 55432) }));
    expect(bracketed.host).toBe("::1");
    expect(bracketed.port).toBe(55432);

    const uppercase = resolveSafeTestDatabase(env({ TEST_DATABASE_URL: testUrl("LOCALHOST") }));
    expect(uppercase.host).toBe("localhost");

    const trailingDot = resolveSafeTestDatabase(env({ TEST_DATABASE_URL: testUrl("LocalHost.") }));
    expect(trailingDot.host).toBe("localhost");
  });

  it("rejects an arbitrary non-production hostname", () => {
    expectSafetyCode(env({ TEST_DATABASE_URL: testUrl("db.example.com") }), "unapproved_host");
    expectSafetyCode(env({ TEST_DATABASE_URL: testUrl("192.168.1.10") }), "unapproved_host");
    expectSafetyCode(
      env({ TEST_DATABASE_URL: testUrl("localhost.example.com") }),
      "unapproved_host",
    );
  });

  it("rejects a production-like host", () => {
    expectSafetyCode(env({ TEST_DATABASE_URL: testUrl("db.prod.example.com") }), "unapproved_host");
    expectSafetyCode(env({ TEST_DATABASE_URL: testUrl("production.internal") }), "unapproved_host");
  });

  it("rejects wildcard and unspecified addresses", () => {
    for (const host of ["0.0.0.0", "[::]"]) {
      expectSafetyCode(env({ TEST_DATABASE_URL: testUrl(host) }), "unapproved_host");
    }
  });

  it("rejects NODE_ENV=production even with an otherwise valid target", () => {
    expectSafetyCode(
      env({
        NODE_ENV: "production",
        TEST_DATABASE_URL: testUrl("localhost"),
      }),
      "production_environment",
    );
  });

  it("rejects the application database even when the URL format differs", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgres://test:test-pass@127.0.0.1:5432/${TEST_DATABASE_NAME}`,
        DATABASE_URL: `postgresql://app:app-pass@127.0.0.1/${TEST_DATABASE_NAME}?sslmode=require`,
      }),
      "same_as_application_database",
    );
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgres://test:test-pass@LOCALHOST:5432/${TEST_DATABASE_NAME}`,
        DATABASE_URL: `postgresql://app:app-pass@localhost:5432/${TEST_DATABASE_NAME}`,
      }),
      "same_as_application_database",
    );
  });

  it("allows the same host and port with a different database name", () => {
    const target = resolveSafeTestDatabase(
      env({
        TEST_DATABASE_URL: `postgresql://test:test-pass@localhost:55432/${TEST_DATABASE_NAME}`,
        DATABASE_URL: "postgresql://app:app-pass@localhost:55432/boyfinity",
      }),
    );
    expect(target.database).toBe(TEST_DATABASE_NAME);
    expect(target.host).toBe("localhost");
    expect(target.port).toBe(55432);
  });

  it("fails closed when DATABASE_URL cannot be parsed", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: testUrl("localhost"),
        DATABASE_URL: "not-a-postgres-url",
      }),
      "unverifiable_database_url",
    );
  });

  it("fails closed when APP_URL cannot be parsed", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: testUrl("localhost"),
        APP_URL: "not-a-url",
      }),
      "unverifiable_app_url",
    );
  });

  it("accepts a valid target and exposes only normalized fields", () => {
    const target = resolveSafeTestDatabase(
      env({
        TEST_DATABASE_URL: `postgresql://user:pass@LOCALHOST:55432/${TEST_DATABASE_NAME}?sslmode=disable`,
      }),
    );
    expect(target).toMatchObject({
      host: "localhost",
      port: 55432,
      database: TEST_DATABASE_NAME,
      user: "user",
      sslMode: "disable",
    });
    expect(target.connectionString).toContain(TEST_DATABASE_NAME);
  });

  it("rejects ambiguous identities and unsupported SSL modes", () => {
    expectSafetyCode(
      env({ TEST_DATABASE_URL: `postgresql://localhost/${TEST_DATABASE_NAME}` }),
      "missing_identity",
    );
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgresql://user:pass@localhost/${TEST_DATABASE_NAME}?sslmode=unsafe`,
      }),
      "invalid_sslmode",
    );
  });

  it("never includes the password in an error message", () => {
    const password = "super-secret-test-password";
    for (const host of ["db.prod.example.com", "db.example.com"]) {
      const message = expectSafetyCode(
        env({ TEST_DATABASE_URL: `postgresql://app:${password}@${host}/${TEST_DATABASE_NAME}` }),
        "unapproved_host",
      );
      expect(message).not.toContain(password);
      expect(message).not.toContain("postgresql://");
    }
  });
});
