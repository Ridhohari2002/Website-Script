import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { createPlaintextKey, hashKeyValue } from "@/modules/keys/crypto";
import { hashHwid } from "@/core/crypto/hwid";
import { createExecutorService, type ExecutorService } from "@/modules/executor/service";
import { AppError } from "@/core/errors";
import {
  CONCURRENCY_TEST_DATABASE_ENV,
  createPgTestDatabase,
  type PgTestDatabase,
} from "../helpers/pg-db";
import { createTestRateLimiter } from "../helpers/keys";

/**
 * Real PostgreSQL proof for executor-first locking, nonce consumption, and
 * session uniqueness.
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
const HWID = "abcdef123456";
const OTHER_HWID = "111111111111";
const ITERATIONS = 5;

interface FixtureOptions {
  /** Simulate a key already claimed through the Discord flow. */
  legacyAuthorized?: boolean;
}

interface Fixture {
  database: PgTestDatabase;
  service: ExecutorService;
  key: string;
  keyId: string;
  scriptId: string;
  scriptPublicId: string;
  userId: string;
  ownerDiscordId: string;
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

  const index = await db.query<{ indexname: string }>(
    "select indexname from pg_indexes where schemaname = 'public' and indexname = $1",
    ["executor_sessions_one_active_per_key"],
  );
  if (index.rows.length !== 1) {
    throw new Error("executor_sessions_one_active_per_key is missing");
  }

  const nonceConstraint = await db.query<{ conname: string }>(
    "select conname from pg_constraint where conname = $1",
    ["executor_nonces_hash_key"],
  );
  if (nonceConstraint.rows.length !== 1) {
    throw new Error("executor_nonces_hash_key is missing");
  }
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const database = await createPgTestDatabase();
  await verifySchema(database.db);

  const suffix = randomUUID();
  const ownerDiscordId = discordId();
  const user = await database.db.query<{ id: string }>(
    "insert into users (discord_id, username) values ($1, $2) returning id",
    [ownerDiscordId, `concurrency-${suffix}`],
  );
  const userId = user.rows[0]!.id;

  const script = await database.db.query<{ id: string; public_id: string }>(
    "insert into scripts (public_id, name, status, enabled) values ($1, $2, 'published', true) returning id, public_id",
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
  const legacyAuthorized = options.legacyAuthorized === true;
  const keyRow = await database.db.query<{ id: string }>(
    `insert into keys
       (key_hash, key_hash_version, key_prefix, type, status, max_activations, product_id,
        user_id, owner_discord_id, executor_claim_authorized_at, executor_claim_authorized_by)
     values ($1, 'v2', $2, 'paid', 'unused', 1, $3, $4, $5, $6, $4)
     returning id`,
    [
      hashKeyValue(key, KEY_SECRET, "v2"),
      key.slice(0, 11),
      productId,
      userId,
      legacyAuthorized ? ownerDiscordId : null,
      legacyAuthorized ? new Date().toISOString() : null,
    ],
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

  return {
    database,
    service,
    key,
    keyId,
    scriptId,
    scriptPublicId: script.rows[0]!.public_id,
    userId,
    ownerDiscordId,
    productId,
  };
}

async function cleanup(fixture: Fixture): Promise<void> {
  const { database, keyId, scriptId, userId, productId } = fixture;
  // Delete only records created by this fixture. Shared tables are never
  // truncated, and messages are ordered around the non-cascade references.
  await database.db.query("delete from script_access_logs where key_id = $1", [keyId]);
  await database.db.query("delete from audit_logs where target_id = $1", [keyId]);
  await database.db.query("delete from audit_logs where actor_user_id = $1", [userId]);
  await database.db.query("delete from keys where id = $1", [keyId]);
  await database.db.query("delete from products where id = $1", [productId]);
  await database.db.query("delete from scripts where id = $1", [scriptId]);
  await database.db.query("delete from users where id = $1", [userId]);
  await database.close();
}

async function withFixture(
  options: FixtureOptions,
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture(options);
  try {
    await work(fixture);
  } finally {
    await cleanup(fixture);
  }
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status !== "fulfilled") throw result.reason;
  return result.value;
}

function rejectedCode(result: PromiseSettledResult<unknown>): string {
  expect(result.status).toBe("rejected");
  const error = (result as PromiseRejectedResult).reason;
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

async function activate(fixture: Fixture, hwid = HWID) {
  return fixture.service.activate({
    request: request("/api/executor/v1/activate"),
    key: fixture.key,
    hwid,
    scriptId: fixture.scriptPublicId,
  });
}

async function validate(fixture: Fixture, sessionToken: string, nonce = randomUUID()) {
  return fixture.service.validate({
    request: request("/api/executor/v1/validate"),
    sessionToken,
    scriptId: fixture.scriptPublicId,
    hwid: HWID,
    timestamp: new Date().toISOString(),
    nonce,
  });
}

async function activeSessionIds(fixture: Fixture): Promise<string[]> {
  const rows = await fixture.database.db.query<{ id: string }>(
    "select id from executor_sessions where key_id = $1 and status = 'active'",
    [fixture.keyId],
  );
  return rows.rows.map((row) => row.id);
}

async function sessionStatus(fixture: Fixture, sessionId: string): Promise<string> {
  const rows = await fixture.database.db.query<{ status: string }>(
    "select status from executor_sessions where id = $1",
    [sessionId],
  );
  return rows.rows[0]!.status;
}

async function grantCount(fixture: Fixture): Promise<number> {
  const rows = await fixture.database.db.query<{ count: number }>(
    "select count(*)::int as count from script_access_logs where key_id = $1 and result = 'granted'",
    [fixture.keyId],
  );
  return rows.rows[0]!.count;
}

async function nonceCount(fixture: Fixture): Promise<number> {
  const rows = await fixture.database.db.query<{ count: number }>(
    "select count(*)::int as count from executor_nonces where key_id = $1",
    [fixture.keyId],
  );
  return rows.rows[0]!.count;
}

async function auditCount(fixture: Fixture, action: string): Promise<number> {
  const rows = await fixture.database.db.query<{ count: number }>(
    "select count(*)::int as count from audit_logs where target_id = $1 and action = $2",
    [fixture.keyId, action],
  );
  return rows.rows[0]!.count;
}

async function keyState(fixture: Fixture): Promise<{
  activation_count: number;
  bound_hwid_hash: string | null;
  user_id: string | null;
  owner_discord_id: string | null;
}> {
  const rows = await fixture.database.db.query<{
    activation_count: number;
    bound_hwid_hash: string | null;
    user_id: string | null;
    owner_discord_id: string | null;
  }>(
    "select activation_count, bound_hwid_hash, user_id, owner_discord_id from keys where id = $1",
    [fixture.keyId],
  );
  return rows.rows[0]!;
}

describe.skipIf(!HAS_TEST_DATABASE)("executor concurrency (real PostgreSQL)", () => {
  it(`A. activation vs validation x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const first = await activate(fixture);
        const [secondActivation, validation] = await Promise.allSettled([
          activate(fixture),
          validate(fixture, first.sessionToken),
        ]);

        const next = fulfilled(secondActivation);
        if (validation.status === "fulfilled") {
          // Validation held the key lock first and granted against the old
          // session; activation then superseded it.
          expect(fulfilled(validation).sessionId).toBe(first.sessionId);
        } else {
          expect(rejectedCode(validation)).toBe("session_revoked");
        }

        const active = await activeSessionIds(fixture);
        expect(active).toHaveLength(1);
        expect(active[0]).toBe(next.sessionId);
        expect(await keyState(fixture)).toMatchObject({ activation_count: 1 });
      });
    }
  });

  it(`B. activation vs activation (same HWID) x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const results = await Promise.allSettled([activate(fixture), activate(fixture)]);
        expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

        const state = await keyState(fixture);
        expect(state.activation_count).toBe(1);
        expect(await activeSessionIds(fixture)).toHaveLength(1);

        const sessions = await fixture.database.db.query<{ status: string; count: number }>(
          `select status, count(*)::int as count
             from executor_sessions where key_id = $1 group by status`,
          [fixture.keyId],
        );
        expect(sessions.rows.find((row) => row.status === "active")?.count).toBe(1);
      });
    }
  });

  it(`C. activation vs activation (different HWID) x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const results = await Promise.allSettled([
          activate(fixture, HWID),
          activate(fixture, OTHER_HWID),
        ]);
        const succeeded = results.map((result) => result.status === "fulfilled");
        expect(succeeded.filter(Boolean)).toHaveLength(1);
        expect(rejectedCode(results.find((result) => result.status === "rejected")!)).toBe(
          "hwid_mismatch",
        );

        const expectedHwid = hashHwid(succeeded[0] ? HWID : OTHER_HWID, HWID_SECRET);
        const state = await keyState(fixture);
        expect(state.bound_hwid_hash).toBe(expectedHwid);
        expect(state.owner_discord_id).toBeNull();
        expect(await activeSessionIds(fixture)).toHaveLength(1);
      });
    }
  });

  it(`D. validation vs revoke x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const activation = await activate(fixture);
        const [validation, revocation] = await Promise.allSettled([
          validate(fixture, activation.sessionToken),
          fixture.service.revokeSession({
            request: request("/api/executor/v1/revoke"),
            sessionToken: activation.sessionToken,
          }),
        ]);

        const revoke = fulfilled(revocation);
        expect(revoke.revoked).toBe(true);
        expect(revoke.status).toBe("revoked");
        expect(await sessionStatus(fixture, activation.sessionId)).toBe("revoked");

        if (validation.status === "fulfilled") {
          expect(await grantCount(fixture)).toBe(1);
          expect(await nonceCount(fixture)).toBe(1);
        } else {
          expect(rejectedCode(validation)).toBe("session_revoked");
          expect(await grantCount(fixture)).toBe(0);
          expect(await nonceCount(fixture)).toBe(0);
        }
        expect(await auditCount(fixture, "executor.session_revoke")).toBe(1);

        // A revoked session never receives a new grant.
        await expect(validate(fixture, activation.sessionToken)).rejects.toMatchObject({
          code: expect.stringMatching(/session_revoked|session_required/),
        });
      });
    }
  });

  it(`E. admin revoke vs activation x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({ legacyAuthorized: true }, async (fixture) => {
        const first = await activate(fixture);
        const [adminRevoke, activation] = await Promise.allSettled([
          fixture.service.adminRevokeSession({
            keyId: fixture.keyId,
            sessionId: first.sessionId,
            adminUserId: fixture.userId,
            request: request("/api/admin/executor/sessions/revoke"),
          }),
          activate(fixture),
        ]);

        const admin = fulfilled(adminRevoke);
        expect(["revoked", "superseded"]).toContain(admin.outcome);
        const next = fulfilled(activation);

        const active = await activeSessionIds(fixture);
        expect(active).toHaveLength(1);
        expect(active[0]).toBe(next.sessionId);

        // Buyer identity is never rewritten by activation or admin revoke.
        const state = await keyState(fixture);
        expect(state.owner_discord_id).toBe(fixture.ownerDiscordId);
        expect(state.user_id).toBe(fixture.userId);
        expect(state.activation_count).toBe(0);
      });
    }
  });

  it(`F. entitlement revocation vs validation x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const activation = await activate(fixture);
        const revocation = fixture.database.db.transaction(async (tx) => {
          await tx.query("update key_entitlements set status = 'revoked' where key_id = $1", [
            fixture.keyId,
          ]);
          return new Date();
        });

        const [validation, revokedAt] = await Promise.allSettled([
          validate(fixture, activation.sessionToken),
          revocation,
        ]);
        const revokedCommittedAt = fulfilled(revokedAt);

        const entitlement = await fixture.database.db.query<{ status: string }>(
          "select status from key_entitlements where key_id = $1",
          [fixture.keyId],
        );
        expect(entitlement.rows[0]!.status).toBe("revoked");

        if (validation.status === "fulfilled") {
          // The FOR SHARE lock forces the revocation to commit after the grant.
          const grant = await fixture.database.db.query<{ created_at: Date }>(
            `select created_at from script_access_logs
              where key_id = $1 and result = 'granted'
              order by created_at desc limit 1`,
            [fixture.keyId],
          );
          expect(grant.rows).toHaveLength(1);
          expect(grant.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(
            revokedCommittedAt.getTime(),
          );
        } else {
          expect(rejectedCode(validation)).toBe("entitlement_suspended");
          expect(await grantCount(fixture)).toBe(0);
        }

        // Once the revocation has committed, validation can never succeed.
        await expect(validate(fixture, activation.sessionToken)).rejects.toMatchObject({
          code: "entitlement_suspended",
        });
      });
    }
  });

  it(`G. nonce replay x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const activation = await activate(fixture);
        const nonce = randomUUID();
        const results = await Promise.allSettled([
          validate(fixture, activation.sessionToken, nonce),
          validate(fixture, activation.sessionToken, nonce),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(rejectedCode(results.find((result) => result.status === "rejected")!)).toBe(
          "replay_detected",
        );
        expect(await nonceCount(fixture)).toBe(1);
        expect(await grantCount(fixture)).toBe(1);
      });
    }
  });

  it(`H. session uniqueness x${ITERATIONS}`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await withFixture({}, async (fixture) => {
        const results = await Promise.allSettled([
          activate(fixture),
          activate(fixture),
          activate(fixture),
          activate(fixture),
        ]);
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);

        const active = await activeSessionIds(fixture);
        expect(active).toHaveLength(1);
        expect((await keyState(fixture)).activation_count).toBe(1);

        const total = await fixture.database.db.query<{ count: number }>(
          "select count(*)::int as count from executor_sessions where key_id = $1",
          [fixture.keyId],
        );
        expect(total.rows[0]!.count).toBe(4);
      });
    }
  });
});
