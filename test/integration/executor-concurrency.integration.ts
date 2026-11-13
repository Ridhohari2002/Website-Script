import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { createPlaintextKey, hashKeyValue } from "@/modules/keys/crypto";
import { createExecutorService, type ExecutorService } from "@/modules/executor/service";
import { AppError } from "@/core/errors";
import {
  CONCURRENCY_TEST_DATABASE_ENV,
  createPgTestDatabase,
  type PgTestDatabase,
} from "../helpers/pg-db";
import { createTestRateLimiter } from "../helpers/keys";

/**
 * Real PostgreSQL proof for executor-first locking and nonce consumption.
 *
 * The PGlite suite serializes transactions, so it cannot show row-lock
 * contention. This file is excluded from `npm test` and runs only through
 * `npm run test:integration:concurrency` against the dedicated
 * `boyfinity_concurrency_test` database.
 */

const HAS_TEST_DATABASE = Boolean(process.env[CONCURRENCY_TEST_DATABASE_ENV]?.trim());
const KEY_SECRET = "concurrency-key-secret-0123456789";
const SESSION_SECRET = "concurrency-session-secret-0123456789";
const HWID_SECRET = "concurrency-hwid-secret-0123456789";

interface Fixture {
  database: PgTestDatabase;
  service: ExecutorService;
  key: string;
  keyId: string;
  scriptId: string;
  userId: string;
  productId: string;
}

function discordId(): string {
  return `${Date.now()}${randomInt(0, 1_000_000).toString().padStart(6, "0")}`;
}

function request(path: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${randomInt(1, 250)}`,
      "user-agent": "executor-concurrency-test",
    },
  });
}

async function verifySchema(db: Db): Promise<void> {
  const migrations = await db.query<{ filename: string }>(
    "select filename from schema_migrations where filename = any($1::text[])",
    [["0001_init.sql", "0002_executor_first.sql", "0003_executor_review_fixes.sql"]],
  );
  const found = new Set(migrations.rows.map((row) => row.filename));
  for (const filename of [
    "0001_init.sql",
    "0002_executor_first.sql",
    "0003_executor_review_fixes.sql",
  ]) {
    if (!found.has(filename)) {
      throw new Error(`${filename} is not recorded. Run npm run db:migrate:test first.`);
    }
  }

  const columns = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'keys'
        and column_name = any($1::text[])`,
    [["executor_claim_authorized_at", "executor_claim_authorized_by", "claim_kind"]],
  );
  const present = new Set(columns.rows.map((row) => row.column_name));
  for (const column of [
    "executor_claim_authorized_at",
    "executor_claim_authorized_by",
    "claim_kind",
  ]) {
    if (!present.has(column)) throw new Error(`keys.${column} is missing`);
  }
}

async function createFixture(): Promise<Fixture> {
  const database = await createPgTestDatabase();
  await verifySchema(database.db);

  const suffix = randomUUID();
  const user = await database.db.query<{ id: string }>(
    "insert into users (discord_id, username) values ($1, $2) returning id",
    [discordId(), `concurrency-${suffix}`],
  );
  const userId = user.rows[0]!.id;

  const script = await database.db.query<{ id: string }>(
    "insert into scripts (public_id, name, status, enabled) values ($1, $2, 'published', true) returning id",
    [`concurrency-${suffix}`, `Concurrency ${suffix}`],
  );
  const scriptId = script.rows[0]!.id;

  const product = await database.db.query<{ id: string }>(
    "insert into products (code, name) values ($1, $2) returning id",
    [`concurrency-${suffix}`, `Concurrency ${suffix}`],
  );
  const productId = product.rows[0]!.id;
  await database.db.query("insert into product_scripts (product_id, script_id) values ($1, $2)", [
    productId,
    scriptId,
  ]);

  const key = createPlaintextKey();
  const keyRow = await database.db.query<{ id: string }>(
    `insert into keys
       (key_hash, key_hash_version, key_prefix, type, status, max_activations, product_id)
     values ($1, 'v2', $2, 'paid', 'unused', 1, $3)
     returning id`,
    [hashKeyValue(key, KEY_SECRET, "v2"), key.slice(0, 11), productId],
  );
  const keyId = keyRow.rows[0]!.id;
  await database.db.query(
    `insert into key_entitlements (key_id, product_id, source, status, starts_at)
     values ($1, $2, 'admin', 'active', '2020-01-01T00:00:00.000Z')`,
    [keyId, productId],
  );

  const service = createExecutorService({
    db: database.db,
    sessionSecret: SESSION_SECRET,
    keySecret: KEY_SECRET,
    keySecretVersion: "v2",
    hwidSecret: HWID_SECRET,
    limiter: createTestRateLimiter(),
  });

  return { database, service, key, keyId, scriptId, userId, productId };
}

async function cleanup(fixture: Fixture): Promise<void> {
  const { database, keyId, scriptId, userId, productId } = fixture;
  // Delete only records created by this fixture. Shared tables are never
  // truncated, and messages are ordered around the non-cascade references.
  await database.db.query("delete from script_access_logs where key_id = $1", [keyId]);
  await database.db.query("delete from audit_logs where target_id = $1", [keyId]);
  await database.db.query("delete from keys where id = $1", [keyId]);
  await database.db.query("delete from products where id = $1", [productId]);
  await database.db.query("delete from scripts where id = $1", [scriptId]);
  await database.db.query("delete from users where id = $1", [userId]);
  await database.close();
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected the operation to fail");
}

async function activate(fixture: Fixture, hwid = "abcdef123456") {
  const script = await fixture.database.db.query<{ public_id: string }>(
    "select public_id from scripts where id = $1",
    [fixture.scriptId],
  );
  return fixture.service.activate({
    request: request("/api/executor/v1/activate"),
    key: fixture.key,
    hwid,
    scriptId: script.rows[0]!.public_id,
  });
}

describe.skipIf(!HAS_TEST_DATABASE)("executor concurrency (real PostgreSQL)", () => {
  it("keeps one active session for concurrent same-HWID activations", async () => {
    const fixture = await createFixture();
    try {
      const results = await Promise.allSettled([activate(fixture), activate(fixture)]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);

      const sessions = await fixture.database.db.query<{ status: string; count: number }>(
        `select status, count(*)::int as count
           from executor_sessions where key_id = $1 group by status`,
        [fixture.keyId],
      );
      const byStatus = Object.fromEntries(sessions.rows.map((row) => [row.status, row.count]));
      expect(byStatus.active).toBe(1);

      const key = await fixture.database.db.query<{ activation_count: number }>(
        "select activation_count from keys where id = $1",
        [fixture.keyId],
      );
      expect(key.rows[0]!.activation_count).toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it("lets exactly one different-HWID activation bind", async () => {
    const fixture = await createFixture();
    try {
      const results = await Promise.allSettled([
        activate(fixture, "abcdef123456"),
        activate(fixture, "111111111111"),
      ]);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as AppError).code).toBe("hwid_mismatch");

      const active = await fixture.database.db.query<{ count: number }>(
        "select count(*)::int as count from executor_sessions where key_id = $1 and status = 'active'",
        [fixture.keyId],
      );
      expect(active.rows[0]!.count).toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it("consumes a nonce atomically so concurrent reuse is rejected", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activate(fixture);
      const script = await fixture.database.db.query<{ public_id: string }>(
        "select public_id from scripts where id = $1",
        [fixture.scriptId],
      );
      const nonce = randomUUID();
      const validateOnce = () =>
        fixture.service.validate({
          request: request("/api/executor/v1/validate"),
          sessionToken: activation.sessionToken,
          scriptId: script.rows[0]!.public_id,
          hwid: "abcdef123456",
          timestamp: new Date().toISOString(),
          nonce,
        });

      const results = await Promise.allSettled([validateOnce(), validateOnce()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect((rejected!.reason as AppError).code).toBe("replay_detected");

      const nonces = await fixture.database.db.query<{ count: number }>(
        "select count(*)::int as count from executor_nonces where key_id = $1",
        [fixture.keyId],
      );
      expect(nonces.rows[0]!.count).toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it("denies validation after the entitlement is revoked", async () => {
    const fixture = await createFixture();
    try {
      const activation = await activate(fixture);
      await fixture.database.db.query(
        "update key_entitlements set status = 'revoked' where key_id = $1",
        [fixture.keyId],
      );
      const script = await fixture.database.db.query<{ public_id: string }>(
        "select public_id from scripts where id = $1",
        [fixture.scriptId],
      );
      expect(
        await errorCode(
          fixture.service.validate({
            request: request("/api/executor/v1/validate"),
            sessionToken: activation.sessionToken,
            scriptId: script.rows[0]!.public_id,
            hwid: "abcdef123456",
            timestamp: new Date().toISOString(),
            nonce: randomUUID(),
          }),
        ),
      ).toBe("entitlement_missing");
    } finally {
      await cleanup(fixture);
    }
  });
});
