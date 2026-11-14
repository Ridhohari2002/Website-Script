import { randomInt, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import { createPlaintextKey, hashKeyValue } from "@/modules/keys/crypto";
import { hashHwid } from "@/core/crypto/hwid";
import { createExecutorService, type ExecutorService } from "@/modules/executor/service";
import { AppError } from "@/core/errors";
import { resolveSafeTestDatabase } from "../../scripts/test-database-guard";
import {
  createPgTestClient,
  createPgTestDatabase,
  TEST_SERVICE_APPLICATION_NAME,
  type PgTestDatabase,
} from "../helpers/pg-db";
import { createTestRateLimiter } from "../helpers/keys";

/**
 * Deterministic real-PostgreSQL concurrency tests.
 *
 * Every interleaving is controlled by row locks held on separate PostgreSQL
 * connections and by polling pg_stat_activity/pg_locks until the expected
 * backend is actually waiting on the expected relation. Promise.all() alone is
 * not treated as proof of concurrency.
 */

const KEY_SECRET = "concurrency-key-secret-0123456789";
const SESSION_SECRET = "concurrency-session-secret-0123456789";
const HWID_SECRET = "concurrency-hwid-secret-0123456789";
const HWID = "abcdef123456";
const OTHER_HWID = "111111111111";

const BLOCKER_APP = "boyfinity-concurrency-test-blocker";
const OLD_ORDER_A_APP = "boyfinity-concurrency-test-old-order-a";
const OLD_ORDER_B_APP = "boyfinity-concurrency-test-old-order-b";
const TRACKED_APPS = [TEST_SERVICE_APPLICATION_NAME, BLOCKER_APP, OLD_ORDER_A_APP, OLD_ORDER_B_APP];

const WAIT_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;

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

interface FixtureOptions {
  /** Simulate a key already claimed through the Discord flow. */
  legacyAuthorized?: boolean;
}

interface LockWaiter {
  pid: number;
  query: string;
  /** Relation named by the waiting statement; row-lock waits themselves are transactionid waits. */
  relation: string | null;
  blockers: number[];
}

interface BlockerContext {
  client: Client;
  pid: number;
  release: (mode?: "commit" | "rollback") => Promise<void>;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${OPERATION_TIMEOUT_MS}ms: ${label}`)),
      OPERATION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Marks a launched operation as handled even if a failed assertion abandons it. */
function tracked<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
  return result.rows[0]!.pid;
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

  const columns = await db.query<{ column_name: string }>(
    `select column_name
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

async function quiesceServiceBackends(fixture: Fixture): Promise<void> {
  const { database } = fixture;
  await database.db.query(
    `select pg_terminate_backend(pid)
       from pg_stat_activity
      where application_name = $1
        and pid <> pg_backend_pid()`,
    [TEST_SERVICE_APPLICATION_NAME],
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const active = await database.db.query<{ count: number }>(
      `select count(*)::int as count
         from pg_stat_activity
        where application_name = $1
          and pid <> pg_backend_pid()`,
      [TEST_SERVICE_APPLICATION_NAME],
    );
    if (active.rows[0]!.count === 0) return;
    await delay(20);
  }
}

async function cleanup(fixture: Fixture): Promise<void> {
  const { database, keyId, scriptId, userId, productId } = fixture;
  // Abandoned service transactions (from a failed assertion) must be closed
  // before fixture-scoped deletes; otherwise they can still insert grants or
  // hold row locks while cleanup runs.
  await quiesceServiceBackends(fixture);
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

async function activate(fixture: Fixture, hwid = HWID) {
  return tracked(
    fixture.service.activate({
      request: request("/api/executor/v1/activate"),
      key: fixture.key,
      hwid,
      scriptId: fixture.scriptPublicId,
    }),
  );
}

async function validate(fixture: Fixture, sessionToken: string, nonce = randomUUID()) {
  return tracked(
    fixture.service.validate({
      request: request("/api/executor/v1/validate"),
      sessionToken,
      scriptId: fixture.scriptPublicId,
      hwid: HWID,
      timestamp: new Date().toISOString(),
      nonce,
    }),
  );
}

async function revoke(fixture: Fixture, sessionToken: string) {
  return tracked(
    fixture.service.revokeSession({
      request: request("/api/executor/v1/revoke"),
      sessionToken,
    }),
  );
}

async function adminRevoke(fixture: Fixture, sessionId: string) {
  return tracked(
    fixture.service.adminRevokeSession({
      keyId: fixture.keyId,
      sessionId,
      adminUserId: fixture.userId,
      request: request("/api/admin/executor/sessions/revoke"),
    }),
  );
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

const LOCK_TARGETS = ["executor_sessions", "key_entitlements", "keys"] as const;

/**
 * A row-lock wait shows up in pg_locks as an ungranted `transactionid` lock
 * with no relation, so the relation must be read from the waiting statement.
 * The statement text is the production SQL fragment, which names the table it
 * is blocked on.
 */
function lockTarget(query: string): string | null {
  const lower = query.toLowerCase();
  for (const relation of LOCK_TARGETS) {
    if (lower.includes(relation)) return relation;
  }
  return null;
}

async function readLockWaiters(db: Db): Promise<LockWaiter[]> {
  const result = await db.query<{ pid: number; query: string; blockers: number[] }>(
    `select a.pid,
            a.query,
            pg_blocking_pids(a.pid) as blockers
       from pg_stat_activity a
      where a.application_name = any($1::text[])
        and a.wait_event_type = 'Lock'`,
    [TRACKED_APPS],
  );
  return result.rows.map((row) => ({
    pid: row.pid,
    query: row.query,
    blockers: row.blockers,
    relation: lockTarget(row.query),
  }));
}

async function waitForWaiter(
  fixture: Fixture,
  match: (waiter: LockWaiter) => boolean,
  label: string,
): Promise<LockWaiter> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const waiters = await readLockWaiters(fixture.database.db);
    const found = waiters.find(match);
    if (found) return found;
    if (Date.now() >= deadline) {
      const observed = waiters.map((waiter) => `${waiter.pid}:${waiter.relation ?? "?"}`);
      throw new Error(
        `Timed out waiting for ${label}. Observed lock waiters: ${observed.join(", ")}`,
      );
    }
    await delay(20);
  }
}

async function withBlocker(
  fixture: Fixture,
  work: (context: BlockerContext) => Promise<void>,
): Promise<void> {
  const client = await createPgTestClient(BLOCKER_APP);
  let released = false;
  try {
    await client.query("begin");
    const pid = await backendPid(client);
    const release = async (mode: "commit" | "rollback" = "rollback"): Promise<void> => {
      if (released) return;
      await client.query(mode);
      released = true;
    };
    await work({ client, pid, release });
  } finally {
    if (!released) {
      try {
        await client.query("rollback");
      } catch {
        // The test failure is the useful one.
      }
    }
    await client.end();
  }
}

async function assertNoDeadlock(results: PromiseSettledResult<unknown>[]): Promise<void> {
  for (const result of results) {
    if (result.status === "rejected") expect(errorCode(result.reason)).not.toBe("40P01");
  }
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status !== "fulfilled") throw result.reason;
  return result.value;
}

function rejectedCode(result: PromiseSettledResult<unknown>): string {
  expect(result.status).toBe("rejected");
  return errorCode((result as PromiseRejectedResult).reason) ?? "";
}

describe("executor concurrency (deterministic real PostgreSQL)", () => {
  beforeAll(() => {
    resolveSafeTestDatabase();
  });

  it("A1. activation-first: validate waits behind the key holder, then sees the superseded session", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const activation = activate(fixture);
        const activationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("update executor_sessions") &&
            waiter.relation === "executor_sessions",
          "activation waiting on the session row",
        );
        expect(activationWait.blockers).toContain(blockerPid);

        const validation = validate(fixture, first.sessionToken);
        const validationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "validation waiting on the key row",
        );

        // Different backend connections, and validation is behind activation's
        // key lock rather than taking the session lock first.
        expect(validationWait.pid).not.toBe(activationWait.pid);
        expect(validationWait.blockers).toContain(activationWait.pid);
        expect(validationWait.relation).not.toBe("executor_sessions");

        await release();

        const settled = await withTimeout(
          Promise.allSettled([activation, validation]),
          "activation-first settlement",
        );
        await assertNoDeadlock(settled);
        const next = fulfilled(settled[0]!);
        expect(rejectedCode(settled[1]!)).toBe("session_revoked");

        const active = await activeSessionIds(fixture);
        expect(active).toEqual([next.sessionId]);
        expect(await grantCount(fixture)).toBe(0);
        expect(await nonceCount(fixture)).toBe(0);
      });
    });
  });

  it("A2. validate-first: validation commits against the old session, then activation replaces it", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const validation = validate(fixture, first.sessionToken);
        const validationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes(
              "from executor_sessions where id = $1 and key_id = $2 for update",
            ) && waiter.relation === "executor_sessions",
          "validation waiting on the session row",
        );
        expect(validationWait.blockers).toContain(blockerPid);

        const activation = activate(fixture);
        const activationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "activation waiting on the key row",
        );
        expect(activationWait.blockers).toContain(validationWait.pid);
        expect(activationWait.pid).not.toBe(validationWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([validation, activation]),
          "validate-first settlement",
        );
        await assertNoDeadlock(settled);
        expect(fulfilled(settled[0]!).sessionId).toBe(first.sessionId);
        const next = fulfilled(settled[1]!);

        expect(await activeSessionIds(fixture)).toEqual([next.sessionId]);
        expect(await grantCount(fixture)).toBe(1);
        expect(await nonceCount(fixture)).toBe(1);
        expect(await sessionStatus(fixture, first.sessionId)).toBe("superseded");
      });
    });
  });

  it("B. simultaneous same-HWID activations queue on the key lock", async () => {
    await withFixture({}, async (fixture) => {
      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from keys where id = $1 for update", [fixture.keyId]);

        const first = activate(fixture);
        const firstWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "first activation waiting on the key row",
        );
        const second = activate(fixture);
        const secondWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== firstWait.pid &&
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "second activation waiting on the key row",
        );

        expect(firstWait.blockers).toContain(blockerPid);
        // The second waiter queues behind the first, so PostgreSQL reports the
        // first waiter (a soft blocker) rather than the original holder.
        expect(secondWait.blockers.some((pid) => pid === blockerPid || pid === firstWait.pid)).toBe(
          true,
        );
        expect(firstWait.pid).not.toBe(secondWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([first, second]),
          "same-HWID activation settlement",
        );
        await assertNoDeadlock(settled);
        expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

        expect(await activeSessionIds(fixture)).toHaveLength(1);
        expect((await keyState(fixture)).activation_count).toBe(1);
        const sessions = await fixture.database.db.query<{ count: number }>(
          "select count(*)::int as count from executor_sessions where key_id = $1",
          [fixture.keyId],
        );
        expect(sessions.rows[0]!.count).toBe(2);
      });
    });
  });

  it("C. simultaneous different-HWID activations keep the binding invariant", async () => {
    await withFixture({}, async (fixture) => {
      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from keys where id = $1 for update", [fixture.keyId]);

        const first = activate(fixture, HWID);
        const firstWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "first different-HWID activation waiting",
        );
        const second = activate(fixture, OTHER_HWID);
        const secondWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== firstWait.pid &&
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "second different-HWID activation waiting",
        );
        expect(firstWait.blockers).toContain(blockerPid);
        expect(secondWait.blockers.some((pid) => pid === blockerPid || pid === firstWait.pid)).toBe(
          true,
        );

        await release();

        const settled = await withTimeout(
          Promise.allSettled([first, second]),
          "different-HWID activation settlement",
        );
        await assertNoDeadlock(settled);
        const succeeded = settled.map((result) => result.status === "fulfilled");
        expect(succeeded.filter(Boolean)).toHaveLength(1);
        expect(rejectedCode(settled.find((result) => result.status === "rejected")!)).toBe(
          "hwid_mismatch",
        );

        const state = await keyState(fixture);
        expect(state.bound_hwid_hash).toBe(hashHwid(succeeded[0] ? HWID : OTHER_HWID, HWID_SECRET));
        expect(state.owner_discord_id).toBeNull();
        expect(await activeSessionIds(fixture)).toHaveLength(1);
      });
    });
  });

  it("D1. validate-first vs revoke: grant commits, then revocation closes the session", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const validation = validate(fixture, first.sessionToken);
        const validationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes(
              "from executor_sessions where id = $1 and key_id = $2 for update",
            ) && waiter.relation === "executor_sessions",
          "validation waiting on the session row",
        );
        expect(validationWait.blockers).toContain(blockerPid);

        const revocation = revoke(fixture, first.sessionToken);
        const revokeWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== validationWait.pid &&
            waiter.query.includes("select id from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "revoke waiting on the key row",
        );
        expect(revokeWait.blockers).toContain(validationWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([validation, revocation]),
          "validate-first revoke settlement",
        );
        await assertNoDeadlock(settled);
        expect(fulfilled(settled[0]!).sessionId).toBe(first.sessionId);
        expect(fulfilled(settled[1]!).revoked).toBe(true);

        expect(await sessionStatus(fixture, first.sessionId)).toBe("revoked");
        expect(await grantCount(fixture)).toBe(1);
        expect(await nonceCount(fixture)).toBe(1);
        expect(await auditCount(fixture, "executor.session_revoke")).toBe(1);
      });
    });
  });

  it("D2. revoke-first vs validate: the revoked session never receives a grant", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const revocation = revoke(fixture, first.sessionToken);
        const revokeWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes(
              "from executor_sessions where id = $1 and key_id = $2 for update",
            ) && waiter.relation === "executor_sessions",
          "revoke waiting on the session row",
        );
        expect(revokeWait.blockers).toContain(blockerPid);

        const validation = validate(fixture, first.sessionToken);
        const validationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== revokeWait.pid &&
            waiter.query.includes("select * from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "validation waiting on the key row",
        );
        expect(validationWait.blockers).toContain(revokeWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([revocation, validation]),
          "revoke-first settlement",
        );
        await assertNoDeadlock(settled);
        expect(fulfilled(settled[0]!).revoked).toBe(true);
        expect(rejectedCode(settled[1]!)).toBe("session_revoked");

        expect(await sessionStatus(fixture, first.sessionId)).toBe("revoked");
        expect(await grantCount(fixture)).toBe(0);
        expect(await nonceCount(fixture)).toBe(0);
        expect(await auditCount(fixture, "executor.session_revoke")).toBe(1);
      });
    });
  });

  it("E1. admin revoke-first vs activation: the revoked session is replaced by one active session", async () => {
    await withFixture({ legacyAuthorized: true }, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const admin = adminRevoke(fixture, first.sessionId);
        const adminWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes(
              "from executor_sessions where id = $1 and key_id = $2 for update",
            ) && waiter.relation === "executor_sessions",
          "admin revoke waiting on the session row",
        );
        expect(adminWait.blockers).toContain(blockerPid);

        const activation = activate(fixture);
        const activationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where key_hash = any") &&
            waiter.relation === "keys",
          "activation waiting on the key row",
        );
        expect(activationWait.blockers).toContain(adminWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([admin, activation]),
          "admin-first settlement",
        );
        await assertNoDeadlock(settled);
        expect(fulfilled(settled[0]!).outcome).toBe("revoked");
        const next = fulfilled(settled[1]!);

        expect(await activeSessionIds(fixture)).toEqual([next.sessionId]);
        const state = await keyState(fixture);
        expect(state.owner_discord_id).toBe(fixture.ownerDiscordId);
        expect(state.user_id).toBe(fixture.userId);
        expect(state.activation_count).toBe(0);
        expect(await auditCount(fixture, "executor.session_revoke_admin")).toBe(1);
      });
    });
  });

  it("E2. activation-first vs admin revoke: admin sees the superseded state and writes no false revocation", async () => {
    await withFixture({ legacyAuthorized: true }, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        const activation = activate(fixture);
        const activationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("update executor_sessions") &&
            waiter.relation === "executor_sessions",
          "activation waiting on the active session row",
        );
        expect(activationWait.blockers).toContain(blockerPid);

        const admin = adminRevoke(fixture, first.sessionId);
        const adminWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== activationWait.pid &&
            waiter.query.includes("select id from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "admin revoke waiting on the key row",
        );
        expect(adminWait.blockers).toContain(activationWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([activation, admin]),
          "activation-first admin settlement",
        );
        await assertNoDeadlock(settled);
        const next = fulfilled(settled[0]!);
        expect(fulfilled(settled[1]!).outcome).toBe("superseded");

        expect(await activeSessionIds(fixture)).toEqual([next.sessionId]);
        expect(await sessionStatus(fixture, first.sessionId)).toBe("superseded");
        expect(await auditCount(fixture, "executor.session_revoke_admin")).toBe(0);
        const state = await keyState(fixture);
        expect(state.owner_discord_id).toBe(fixture.ownerDiscordId);
        expect(state.user_id).toBe(fixture.userId);
      });
    });
  });

  it("F. in-flight entitlement revocation blocks validation until its own lock resolves", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("update key_entitlements set status = 'revoked' where key_id = $1", [
          fixture.keyId,
        ]);

        const validation = validate(fixture, first.sessionToken);
        const validationWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.relation === "key_entitlements" && waiter.blockers.includes(blockerPid),
          "validation waiting on the entitlement share lock",
        );
        expect(validationWait.pid).not.toBe(blockerPid);

        await release("commit");

        const settled = await withTimeout(
          Promise.allSettled([validation]),
          "entitlement revocation settlement",
        );
        await assertNoDeadlock(settled);
        expect(rejectedCode(settled[0]!)).toBe("entitlement_suspended");

        const entitlement = await fixture.database.db.query<{ status: string }>(
          "select status from key_entitlements where key_id = $1",
          [fixture.keyId],
        );
        expect(entitlement.rows[0]!.status).toBe("revoked");
        expect(await grantCount(fixture)).toBe(0);
        expect(await nonceCount(fixture)).toBe(0);

        await expect(validate(fixture, first.sessionToken)).rejects.toMatchObject({
          code: "entitlement_suspended",
        });
      });
    });
  });

  it("G. parallel nonce replay: exactly one transaction consumes the nonce", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);
      const nonce = randomUUID();

      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from keys where id = $1 for update", [fixture.keyId]);

        const one = validate(fixture, first.sessionToken, nonce);
        const oneWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.query.includes("select * from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "first nonce validation waiting on the key row",
        );
        const two = validate(fixture, first.sessionToken, nonce);
        const twoWait = await waitForWaiter(
          fixture,
          (waiter) =>
            waiter.pid !== oneWait.pid &&
            waiter.query.includes("select * from keys where id = $1 for update") &&
            waiter.relation === "keys",
          "second nonce validation waiting on the key row",
        );
        expect(oneWait.blockers).toContain(blockerPid);
        expect(twoWait.blockers.some((pid) => pid === blockerPid || pid === oneWait.pid)).toBe(
          true,
        );
        expect(oneWait.pid).not.toBe(twoWait.pid);

        await release();

        const settled = await withTimeout(
          Promise.allSettled([one, two]),
          "nonce replay settlement",
        );
        await assertNoDeadlock(settled);
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(rejectedCode(settled.find((result) => result.status === "rejected")!)).toBe(
          "replay_detected",
        );
        expect(await nonceCount(fixture)).toBe(1);
        expect(await grantCount(fixture)).toBe(1);
      });
    });
  });

  it("H. four concurrent activations are serialized by one key lock and the unique index", async () => {
    await withFixture({}, async (fixture) => {
      await withBlocker(fixture, async ({ client, pid: blockerPid, release }) => {
        await client.query("select id from keys where id = $1 for update", [fixture.keyId]);

        const activations = [
          activate(fixture),
          activate(fixture),
          activate(fixture),
          activate(fixture),
        ];
        const waits: LockWaiter[] = [];
        for (let index = 0; index < activations.length; index += 1) {
          const waiter = await waitForWaiter(
            fixture,
            (candidate) =>
              !waits.some((seen) => seen.pid === candidate.pid) &&
              candidate.query.includes("select * from keys where key_hash = any") &&
              candidate.relation === "keys",
            `activation ${index + 1} waiting on the key row`,
          );
          waits.push(waiter);
        }
        // Every activation is queued behind the blocker or behind an earlier
        // activation in the same lock queue; none is blocked by an unrelated
        // session, which rules out a lock cycle.
        expect(
          waits.every((waiter) =>
            waiter.blockers.some(
              (pid) => pid === blockerPid || waits.some((other) => other.pid === pid),
            ),
          ),
        ).toBe(true);
        expect(new Set(waits.map((waiter) => waiter.pid)).size).toBe(4);

        await release();

        const settled = await withTimeout(
          Promise.allSettled(activations),
          "session uniqueness settlement",
        );
        await assertNoDeadlock(settled);
        expect(settled.every((result) => result.status === "fulfilled")).toBe(true);

        expect(await activeSessionIds(fixture)).toHaveLength(1);
        expect((await keyState(fixture)).activation_count).toBe(1);
        const sessions = await fixture.database.db.query<{ count: number }>(
          "select count(*)::int as count from executor_sessions where key_id = $1",
          [fixture.keyId],
        );
        expect(sessions.rows[0]!.count).toBe(4);
      });
    });
  });

  it("I. the old session-first order deadlocks under controlled locks; the service order does not", async () => {
    await withFixture({}, async (fixture) => {
      const first = await activate(fixture);

      const oldA = await createPgTestClient(OLD_ORDER_A_APP);
      const oldB = await createPgTestClient(OLD_ORDER_B_APP);
      let oldAPid: number | null = null;
      let oldBPid: number | null = null;
      let oldAWait: Promise<"resolved"> | null = null;
      let oldBWait: Promise<"resolved"> | null = null;
      try {
        await oldA.query("begin");
        await oldB.query("begin");
        oldAPid = await backendPid(oldA);
        oldBPid = await backendPid(oldB);
        expect(oldAPid).not.toBe(oldBPid);

        // Old order A: keys -> executor_sessions.
        await oldA.query("select id from keys where id = $1 for update", [fixture.keyId]);
        // Old order B: executor_sessions -> keys.
        await oldB.query("select id from executor_sessions where id = $1 for update", [
          first.sessionId,
        ]);

        oldAWait = tracked(
          oldA
            .query("select id from executor_sessions where id = $1 for update", [first.sessionId])
            .then(() => "resolved" as const),
        );
        await waitForWaiter(
          fixture,
          (waiter) => waiter.pid === oldAPid && waiter.relation === "executor_sessions",
          "old-order A waiting on the session row",
        );

        oldBWait = tracked(
          oldB
            .query("select id from keys where id = $1 for update", [fixture.keyId])
            .then(() => "resolved" as const),
        );

        const settled = await withTimeout(
          Promise.allSettled([oldAWait, oldBWait]),
          "old-order deadlock reproduction",
        );
        const deadlocks = settled.filter(
          (result) => result.status === "rejected" && errorCode(result.reason) === "40P01",
        );
        expect(deadlocks).toHaveLength(1);
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      } finally {
        // A blocked query cannot be followed by ROLLBACK on the same client.
        // Terminating the backend aborts its transaction and releases the row
        // locks without waiting for the blocked statement.
        if (oldAPid !== null) {
          await fixture.database.db
            .query("select pg_terminate_backend($1)", [oldAPid])
            .catch(() => undefined);
        }
        if (oldBPid !== null) {
          await fixture.database.db
            .query("select pg_terminate_backend($1)", [oldBPid])
            .catch(() => undefined);
        }
        await oldAWait?.catch(() => undefined);
        await oldBWait?.catch(() => undefined);
        await oldA.end().catch(() => undefined);
        await oldB.end().catch(() => undefined);
      }

      // The controlled service regression is A1: activation holds keys and
      // waits for the session row, while validation waits behind the key lock
      // instead of taking the session lock first.
      const state = await keyState(fixture);
      expect(state.activation_count).toBe(1);
      expect(await activeSessionIds(fixture)).toEqual([first.sessionId]);
    });
  });
});
