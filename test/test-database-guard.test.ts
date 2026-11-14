import { describe, expect, it } from "vitest";
import {
  resolveSafeTestDatabase,
  TestDatabaseSafetyError,
  TEST_DATABASE_ENV,
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

  it("rejects a production-like host", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgresql://user:pass@db.prod.example.com/${TEST_DATABASE_NAME}`,
      }),
      "production_host",
    );
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgresql://user:pass@production.internal/${TEST_DATABASE_NAME}`,
      }),
      "production_host",
    );
  });

  it("rejects NODE_ENV=production even with an otherwise valid target", () => {
    expectSafetyCode(
      env({
        NODE_ENV: "production",
        TEST_DATABASE_URL: `postgresql://user:pass@localhost/${TEST_DATABASE_NAME}`,
      }),
      "production_environment",
    );
  });

  it("rejects the application database even when the URL format differs", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgres://test:test-pass@DB.EXAMPLE.com:5432/${TEST_DATABASE_NAME}`,
        DATABASE_URL: `postgresql://app:app-pass@db.example.com/${TEST_DATABASE_NAME}?sslmode=require`,
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
        TEST_DATABASE_URL: `postgresql://user:pass@localhost/${TEST_DATABASE_NAME}`,
        DATABASE_URL: "not-a-postgres-url",
      }),
      "unverifiable_database_url",
    );
  });

  it("rejects a test host that is the production APP_URL host", () => {
    expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgresql://user:pass@app.example.com/${TEST_DATABASE_NAME}`,
        APP_URL: "https://app.example.com",
      }),
      "production_host",
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
    expectSafetyCode(
      env({ TEST_DATABASE_URL: `postgresql://user:pass@0.0.0.0/${TEST_DATABASE_NAME}` }),
      "production_host",
    );
  });

  it("never includes the password in an error message", () => {
    const password = "super-secret-test-password";
    const message = expectSafetyCode(
      env({
        TEST_DATABASE_URL: `postgresql://app:${password}@db.prod.example.com/${TEST_DATABASE_NAME}`,
      }),
      "production_host",
    );
    expect(message).not.toContain(password);
    expect(message).not.toContain("postgresql://");
  });
});
