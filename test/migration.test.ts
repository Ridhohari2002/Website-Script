import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration is executed against an embedded PostgreSQL build. This proves
 * the SQL applies from zero and that the important constraints are live; it is
 * not a substitute for running against the hosted database.
 */

let db: PGlite;

let userId: string;
let planId: string;
let scriptId: string;
let keyId: string;
let banId: string;
let offerId: string;
let checkKeyCategory: string;
let checkKeyConfidence: string;
let checkKeyReview: string;

beforeAll(async () => {
  db = new PGlite();
  const sqlText = await readFile(
    join(process.cwd(), "supabase", "migrations", "0001_init.sql"),
    "utf8",
  );
  await db.exec(sqlText);

  const makeKey = async (hash: string) => {
    const result = await db.query<{ id: string }>(
      "insert into keys (key_hash, status) values ($1, 'active') returning id",
      [hash],
    );
    return result.rows[0]!.id;
  };

  const user = await db.query<{ id: string }>(
    "insert into users (discord_id) values ('fixture-user') returning id",
  );
  userId = user.rows[0]!.id;

  const plan = await db.query<{ id: string }>(
    `insert into plans (code, name, duration_days, price_minor)
     values ('monthly', 'Monthly', 30, 50000) returning id`,
  );
  planId = plan.rows[0]!.id;

  const script = await db.query<{ id: string }>(
    `insert into scripts (public_id, name) values ('script-fixture', 'Fixture') returning id`,
  );
  scriptId = script.rows[0]!.id;

  const key = await makeKey("fixture-key");
  keyId = key;

  const ban = await db.query<{ id: string }>(
    `insert into key_bans
       (key_id, reason, detected_at, banned_at, detection_category, confidence, review_status)
     values ($1, 'fixture', now(), now(), 'other', 'confirmed', 'confirmed')
     returning id`,
    [keyId],
  );
  banId = ban.rows[0]!.id;

  checkKeyCategory = await makeKey("check-key-category");
  checkKeyConfidence = await makeKey("check-key-confidence");
  checkKeyReview = await makeKey("check-key-review");

  const offer = await db.query<{ id: string }>(
    "insert into offers (provider, code) values ('test-provider', 'welcome') returning id",
  );
  offerId = offer.rows[0]!.id;
});

afterAll(async () => {
  await db.close();
});

async function insertUser(discordId: string, status = "active") {
  return db.query<{ id: string }>(
    "insert into users (discord_id, status) values ($1, $2) returning id",
    [discordId, status],
  );
}

describe("Phase 1 migration", () => {
  it("creates the full core table set", async () => {
    const result = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    const tables = result.rows.map((row) => row.tablename);
    for (const expected of [
      "users",
      "user_roles",
      "sessions",
      "oauth_states",
      "keys",
      "key_bans",
      "key_ban_reversals",
      "key_sessions",
      "idempotency_keys",
      "rate_limit_counters",
      "jobs",
      "audit_logs",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("accepts a valid user and rejects an invalid status", async () => {
    const inserted = await insertUser("discord-1");
    expect(inserted.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(insertUser("discord-2", "banned")).rejects.toThrow(/users_status_check/);
  });

  it("enforces the unique discord identity anchor", async () => {
    await insertUser("discord-duplicate");
    await expect(insertUser("discord-duplicate")).rejects.toThrow(/users_discord_id_key/);
  });

  it("enforces the scope/key uniqueness of idempotency records", async () => {
    await db.query(
      `insert into idempotency_keys (scope, key_hash, request_hash, expires_at)
       values ('payments', 'key-1', 'req-1', now() + interval '1 day')`,
    );
    await expect(
      db.query(
        `insert into idempotency_keys (scope, key_hash, request_hash, expires_at)
         values ('payments', 'key-1', 'req-2', now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/idempotency_keys_scope_key_unique/);
  });

  it("keeps at most one live ban per key", async () => {
    const key = await db.query<{ id: string }>(
      "insert into keys (key_hash, status) values ('hash-live-ban', 'active') returning id",
    );
    const liveKeyId = key.rows[0]!.id;
    const ban = `insert into key_bans
        (key_id, reason, detected_at, banned_at, detection_category, confidence, review_status)
      values ($1, 'test', now(), now(), 'other', 'confirmed', 'confirmed')`;
    await db.query(ban, [liveKeyId]);
    await expect(db.query(ban, [liveKeyId])).rejects.toThrow(/key_bans_live_unique/);
  });

  it("rejects a second pending reversal for the same ban", async () => {
    const insert = `insert into key_ban_reversals
        (ban_id, key_id, requested_by, justification, status)
      values ($1, $2, $3, 'review please', 'pending_approval')`;
    await db.query(insert, [banId, keyId, userId]);
    await expect(db.query(insert, [banId, keyId, userId])).rejects.toThrow(
      /key_ban_reversals_open_unique/,
    );
  });

  it("rejects a second unused reactivation authorization for the same key", async () => {
    const insert = `insert into key_reactivations (key_id, ban_id, authorized_by, reason)
      values ($1, $2, $3, 'restore access')`;
    await db.query(insert, [keyId, banId, userId]);
    await expect(db.query(insert, [keyId, banId, userId])).rejects.toThrow(
      /key_reactivations_unused_unique/,
    );
  });

  it("enforces the reversal lifecycle shape", async () => {
    await expect(
      db.query(
        `insert into key_ban_reversals (ban_id, key_id, requested_by, justification, status)
         values ($1, $2, $3, 'x', 'approved')`,
        [banId, keyId, userId],
      ),
    ).rejects.toThrow();
  });

  it("enables row level security on public tables", async () => {
    const result = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(result.rows.length).toBeGreaterThan(20);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    }
  });

  it("declares no permissive RLS policies", async () => {
    const result = await db.query<{ count: number }>(
      "select count(*)::int as count from pg_policies where schemaname = 'public'",
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("denies anonymous reads and writes through RLS", async () => {
    await db.exec("create role rls_anon nologin");
    await db.exec("grant select, insert on users to rls_anon");
    try {
      await db.exec("set role rls_anon");
      const reads = await db.query("select id from users");
      expect(reads.rows).toHaveLength(0);
      await expect(
        db.query("insert into users (discord_id) values ('rls-intruder')"),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("status CHECK constraints", () => {
  const cases: Array<{
    name: string;
    sql: string;
    params: unknown[] | (() => unknown[]);
    constraint: RegExp;
  }> = [
    {
      name: "users.status",
      sql: "insert into users (discord_id, status) values ('bad-status', 'bogus')",
      params: [],
      constraint: /users_status_check/,
    },
    {
      name: "scripts.status",
      sql: "insert into scripts (public_id, name, status) values ('bad-script', 'Bad', 'bogus')",
      params: [],
      constraint: /scripts_status_check/,
    },
    {
      name: "transactions.status",
      sql: `insert into transactions (user_id, provider, amount_minor, status)
            values ($1, 'test', 1000, 'bogus')`,
      params: () => [userId],
      constraint: /transactions_status_check/,
    },
    {
      name: "subscriptions.status",
      sql: `insert into subscriptions (user_id, plan_id, status) values ($1, $2, 'bogus')`,
      params: () => [userId, planId],
      constraint: /subscriptions_status_check/,
    },
    {
      name: "keys.type",
      sql: "insert into keys (key_hash, type) values ('bad-type', 'bogus')",
      params: [],
      constraint: /keys_type_check/,
    },
    {
      name: "keys.status",
      sql: "insert into keys (key_hash, status) values ('bad-key-status', 'bogus')",
      params: [],
      constraint: /keys_status_check/,
    },
    {
      name: "key_bans.detection_category",
      sql: `insert into key_bans
              (key_id, reason, detected_at, detection_category, confidence)
            values ($1, 'x', now(), 'bogus', 'high')`,
      params: () => [checkKeyCategory],
      constraint: /key_bans_detection_category_check/,
    },
    {
      name: "key_bans.confidence",
      sql: `insert into key_bans
              (key_id, reason, detected_at, detection_category, confidence)
            values ($1, 'x', now(), 'other', 'bogus')`,
      params: () => [checkKeyConfidence],
      constraint: /key_bans_confidence_check/,
    },
    {
      name: "key_bans.review_status",
      sql: `insert into key_bans
              (key_id, reason, detected_at, detection_category, confidence, review_status)
            values ($1, 'x', now(), 'other', 'high', 'bogus')`,
      params: () => [checkKeyReview],
      constraint: /key_bans_review_status_check/,
    },
    {
      name: "key_ban_reversals.status",
      sql: `insert into key_ban_reversals (ban_id, key_id, requested_by, justification, status)
            values ($1, $2, $3, 'x', 'bogus')`,
      params: () => [banId, keyId, userId],
      constraint: /key_ban_reversals_(status|lifecycle)_check/,
    },
    {
      name: "key_ban_evidence.evidence_type",
      sql: `insert into key_ban_evidence (ban_id, evidence_type)
            values ($1, 'bogus')`,
      params: () => [banId],
      constraint: /key_ban_evidence_type_check/,
    },
    {
      name: "key_device_history.event",
      sql: "insert into key_device_history (key_id, event) values ($1, 'bogus')",
      params: () => [keyId],
      constraint: /key_device_history_event_check/,
    },
    {
      name: "key_hwid_resets.performed_by",
      sql: "insert into key_hwid_resets (key_id, performed_by) values ($1, 'bogus')",
      params: () => [keyId],
      constraint: /key_hwid_resets_performed_by_check/,
    },
    {
      name: "key_sessions.status",
      sql: `insert into key_sessions
              (key_id, user_id, session_token_hash, status, expires_at)
            values ($1, $2, 'bad-session-status', 'bogus', now() + interval '1 day')`,
      params: () => [keyId, userId],
      constraint: /key_sessions_status_check/,
    },
    {
      name: "script_access_logs.result",
      sql: "insert into script_access_logs (script_id, result) values ($1, 'bogus')",
      params: () => [scriptId],
      constraint: /script_access_logs_result_check/,
    },
    {
      name: "offer_completions.status",
      sql: `insert into offer_completions (offer_id, user_id, provider_event_id, status)
            values ($1, $2, 'bad-offer-status', 'bogus')`,
      params: () => [offerId, userId],
      constraint: /offer_completions_status_check/,
    },
    {
      name: "jobs.status",
      sql: "insert into jobs (name, status) values ('bad-job', 'bogus')",
      params: [],
      constraint: /jobs_status_check/,
    },
    {
      name: "idempotency_keys.status",
      sql: `insert into idempotency_keys (scope, key_hash, request_hash, status, expires_at)
            values ('x', 'bad-idem-status', 'r', 'bogus', now() + interval '1 day')`,
      params: [],
      constraint: /idempotency_keys_status_check/,
    },
  ];

  for (const testCase of cases) {
    it(`rejects an invalid ${testCase.name}`, async () => {
      const params = typeof testCase.params === "function" ? testCase.params() : testCase.params;
      const promise = db.query(testCase.sql, params);
      await expect(promise).rejects.toThrow(testCase.constraint);
    });
  }
});
