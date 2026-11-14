import { randomInt, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@/core/logger";
import type { Db } from "@/db/client";
import { MAX_ACTIVE_SESSIONS, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import { hashOAuthState } from "@/modules/auth/crypto";
import { createAuthService } from "@/modules/auth/service";
import type { DiscordOAuthClient } from "@/providers/discord/client";
import { resolveSafeTestDatabase } from "../../scripts/test-database-guard";
import { createPgTestDatabase, type PgTestDatabase } from "../helpers/pg-db";

/**
 * Real PostgreSQL concurrency test.
 *
 * The PGlite suite serializes transactions behind one in-process mutex, so it
 * cannot demonstrate PostgreSQL row-lock contention. This file runs against a
 * dedicated real database and drives real BEGIN/COMMIT transactions through a
 * pg.Pool. It is excluded from `npm test` and must only be run with
 * `npm run test:integration:concurrency`.
 */

const BASE = "http://localhost:3000";
const TEST_SESSION_SECRET = "concurrency-test-session-secret-0123456789";
const TEST_CONFIG = {
  clientId: "123456789012345678",
  clientSecret: "concurrency-test-client-secret-not-real",
  redirectUri: `${BASE}/api/auth/callback`,
  appUrl: BASE,
};
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

interface LoginAttempt {
  state: string;
  request: Request;
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const pair = line.split(";")[0]?.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return null;
}

function sessionCookieFrom(setCookies: readonly string[]): string {
  const token = cookieValue(setCookies, SESSION_COOKIE);
  if (!token) throw new Error("login did not return a session cookie");
  return `${SESSION_COOKIE}=${token}`;
}

function generateDiscordId(): string {
  const value = `${Date.now()}${randomInt(0, 1_000_000).toString().padStart(6, "0")}`;
  if (!/^\d{17,20}$/.test(value)) throw new Error("generated Discord id is invalid");
  return value;
}

function fakeDiscord(discordId: string, username: string): DiscordOAuthClient {
  return {
    async exchangeCode() {
      return { accessToken: "fake-access-token", tokenType: "Bearer", scope: "identify" };
    },
    async fetchProfile() {
      return { id: discordId, username, globalName: username, avatar: null };
    },
  };
}

async function verifySchema(db: Db): Promise<void> {
  const migration = await db.query<{ filename: string }>(
    "select filename from schema_migrations where filename = $1",
    ["0001_init.sql"],
  );
  if (migration.rows.length !== 1) {
    throw new Error(
      "0001_init.sql is not recorded in schema_migrations. Run npm run db:migrate:test first.",
    );
  }

  const required: Array<{ table: string; column: string }> = [
    { table: "users", column: "id" },
    { table: "users", column: "discord_id" },
    { table: "user_roles", column: "user_id" },
    { table: "sessions", column: "id" },
    { table: "sessions", column: "user_id" },
    { table: "sessions", column: "token_hash" },
    { table: "sessions", column: "created_at" },
    { table: "sessions", column: "revoked_at" },
    { table: "sessions", column: "expires_at" },
    { table: "sessions", column: "absolute_expires_at" },
    { table: "sessions", column: "last_seen_at" },
    { table: "oauth_states", column: "state_hash" },
    { table: "oauth_states", column: "code_verifier" },
    { table: "oauth_states", column: "expires_at" },
    { table: "oauth_states", column: "consumed_at" },
    { table: "audit_logs", column: "id" },
    { table: "audit_logs", column: "actor_user_id" },
    { table: "audit_logs", column: "action" },
    { table: "audit_logs", column: "target_id" },
    { table: "audit_logs", column: "metadata" },
  ];
  const tables = [...new Set(required.map((entry) => entry.table))];
  const columns = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])`,
    [tables],
  );
  const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = required.filter((entry) => !present.has(`${entry.table}.${entry.column}`));
  if (missing.length > 0) {
    throw new Error(
      `concurrency test schema is incomplete: ${missing
        .map((entry) => `${entry.table}.${entry.column}`)
        .join(", ")}`,
    );
  }
}

async function cleanup(db: Db, discordId: string, stateHashes: readonly string[]): Promise<void> {
  const user = await db.query<{ id: string }>("select id from users where discord_id = $1", [
    discordId,
  ]);
  const userId = user.rows[0]?.id;
  if (userId) {
    // audit_logs has no ON DELETE CASCADE, so remove its rows before the user.
    await db.query("delete from audit_logs where actor_user_id = $1 or target_id = $1::text", [
      userId,
    ]);
    await db.query("delete from users where id = $1", [userId]);
  }
  if (stateHashes.length > 0) {
    await db.query("delete from oauth_states where state_hash = any($1::text[])", [
      [...stateHashes],
    ]);
  }
}

describe("real PostgreSQL session-cap concurrency", () => {
  beforeAll(() => {
    resolveSafeTestDatabase();
  });

  it(
    "never exceeds five active sessions under concurrent completeLogin calls",
    { timeout: 60_000 },
    async () => {
      const database: PgTestDatabase = await createPgTestDatabase();
      const discordId = generateDiscordId();
      const username = `concurrency-${randomUUID()}`;
      const attempts: LoginAttempt[] = [];
      let primaryError: unknown;
      let userId: string | null = null;

      const logs: string[] = [];
      const logger = createLogger({
        level: "error",
        sink: (line) => logs.push(line),
      });
      const service = createAuthService({
        db: database.db,
        clock: () => new Date(FIXED_NOW),
        discord: fakeDiscord(discordId, username),
        config: TEST_CONFIG,
        logger,
        sessionSecret: TEST_SESSION_SECRET,
        secureCookies: false,
      });

      try {
        // Reads only: refuse to write unless the dedicated database contains the
        // reviewed migration and every column this test depends on.
        await verifySchema(database.db);

        expect(MAX_ACTIVE_SESSIONS).toBe(5);
        const loginCount = MAX_ACTIVE_SESSIONS + 3;

        // Create independent OAuth states sequentially, then complete every
        // login concurrently. startLogin writes one oauth_states row per attempt.
        for (let index = 0; index < loginCount; index += 1) {
          const start = await service.startLogin({ next: "/dashboard" });
          const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE);
          if (!state) throw new Error("startLogin did not return an OAuth state");
          attempts.push({
            state,
            request: new Request(
              `${BASE}/api/auth/callback?code=test-code-${index}&state=${encodeURIComponent(state)}`,
              {
                headers: {
                  cookie: `${OAUTH_STATE_COOKIE}=${state}`,
                  "user-agent": BROWSER_USER_AGENT,
                },
              },
            ),
          });
        }

        const results = await Promise.allSettled(
          attempts.map((attempt, index) =>
            service.completeLogin({
              request: attempt.request,
              code: `test-code-${index}`,
              state: attempt.state,
              oauthError: null,
            }),
          ),
        );

        const sessionCookies: string[] = [];
        for (const [index, settled] of results.entries()) {
          if (settled.status !== "fulfilled") {
            throw new Error(`login ${index} rejected unexpectedly`);
          }
          if (!settled.value.ok) {
            throw new Error(`login ${index} failed with ${settled.value.reason}`);
          }
          sessionCookies.push(sessionCookieFrom(settled.value.cookies));
        }
        expect(sessionCookies).toHaveLength(loginCount);

        const users = await database.db.query<{ id: string }>(
          "select id from users where discord_id = $1",
          [discordId],
        );
        expect(users.rows).toHaveLength(1);
        userId = users.rows[0]!.id;

        const total = await database.db.query<{ count: number }>(
          "select count(*)::int as count from sessions where user_id = $1",
          [userId],
        );
        expect(total.rows[0]!.count).toBe(loginCount);

        const active = await database.db.query<{ count: number }>(
          `select count(*)::int as count
             from sessions
            where user_id = $1
              and revoked_at is null
              and expires_at > $2
              and (absolute_expires_at is null or absolute_expires_at > $2)`,
          [userId, FIXED_NOW.toISOString()],
        );
        expect(active.rows[0]!.count).toBe(MAX_ACTIVE_SESSIONS);

        const revoked = await database.db.query<{ count: number }>(
          "select count(*)::int as count from sessions where user_id = $1 and revoked_at is not null",
          [userId],
        );
        expect(revoked.rows[0]!.count).toBe(loginCount - MAX_ACTIVE_SESSIONS);

        // The fixed clock makes every created_at identical, so eviction is
        // decided purely by the id-ascending tie-breaker. Concurrent logins
        // commit in a nondeterministic order, and each one evicts the oldest
        // active row *before* inserting its own session, so the final revoked
        // set is not simply a prefix of the final (created_at, id) order. The
        // tie-breaker is proven deterministically by the extra login below.
        const ordered = await database.db.query<{
          id: string;
          created_at: Date;
          revoked_at: Date | null;
        }>(
          `select id, created_at, revoked_at
             from sessions
             where user_id = $1
             order by created_at asc, id asc`,
          [userId],
        );
        expect(ordered.rows).toHaveLength(loginCount);
        expect(new Set(ordered.rows.map((row) => row.created_at.getTime())).size).toBe(1);
        expect(ordered.rows.filter((row) => row.revoked_at)).toHaveLength(
          loginCount - MAX_ACTIVE_SESSIONS,
        );

        const loginAudit = await database.db.query<{ count: number }>(
          `select count(*)::int as count
             from audit_logs
            where actor_user_id = $1 and action = 'auth.login'`,
          [userId],
        );
        expect(loginAudit.rows[0]!.count).toBe(loginCount);

        const evictionAudit = await database.db.query<{ count: number; revoked: number }>(
          `select count(*)::int as count,
                  coalesce(sum((metadata->>'revokedSessions')::int), 0)::int as revoked
             from audit_logs
            where actor_user_id = $1 and action = 'auth.session_limit_enforced'`,
          [userId],
        );
        expect(evictionAudit.rows[0]!.count).toBe(loginCount - MAX_ACTIVE_SESSIONS);
        expect(evictionAudit.rows[0]!.revoked).toBe(loginCount - MAX_ACTIVE_SESSIONS);

        const badEvictionMetadata = await database.db.query<{ count: number }>(
          `select count(*)::int as count
             from audit_logs
            where actor_user_id = $1
              and action = 'auth.session_limit_enforced'
              and (
                (metadata->>'maxSessions')::int <> $2
                or (metadata->>'revokedSessions')::int <> 1
              )`,
          [userId, MAX_ACTIVE_SESSIONS],
        );
        expect(badEvictionMetadata.rows[0]!.count).toBe(0);

        const failedAudit = await database.db.query<{ count: number }>(
          `select count(*)::int as count
             from audit_logs
            where actor_user_id = $1 and action = 'auth.login_failed'`,
          [userId],
        );
        expect(failedAudit.rows[0]!.count).toBe(0);

        let accepted = 0;
        let rejected = 0;
        for (const cookie of sessionCookies) {
          const resolved = await service.resolveSession(
            new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
          );
          if (resolved) accepted += 1;
          else rejected += 1;
        }
        expect(accepted).toBe(MAX_ACTIVE_SESSIONS);
        expect(rejected).toBe(loginCount - MAX_ACTIVE_SESSIONS);
        expect(logs).toEqual([]);

        // Deterministic proof of the (created_at, id) tie-breaker: every row
        // shares the fixed created_at, so the next login must revoke exactly
        // the smallest-id active session and leave the cap intact.
        const beforeExtra = await database.db.query<{ id: string }>(
          `select id
             from sessions
            where user_id = $1
              and revoked_at is null
              and expires_at > $2
              and (absolute_expires_at is null or absolute_expires_at > $2)
            order by created_at asc, id asc`,
          [userId, FIXED_NOW.toISOString()],
        );
        expect(beforeExtra.rows).toHaveLength(MAX_ACTIVE_SESSIONS);
        const expectedVictim = beforeExtra.rows[0]!.id;

        const extraStart = await service.startLogin({ next: "/dashboard" });
        const extraState = cookieValue(extraStart.cookies, OAUTH_STATE_COOKIE);
        if (!extraState) throw new Error("extra startLogin did not return an OAuth state");
        const extraRequest = new Request(
          `${BASE}/api/auth/callback?code=extra&state=${encodeURIComponent(extraState)}`,
          {
            headers: {
              cookie: `${OAUTH_STATE_COOKIE}=${extraState}`,
              "user-agent": BROWSER_USER_AGENT,
            },
          },
        );
        attempts.push({ state: extraState, request: extraRequest });

        const extraLogin = await service.completeLogin({
          request: extraRequest,
          code: "extra",
          state: extraState,
          oauthError: null,
        });
        expect(extraLogin.ok).toBe(true);

        const afterExtra = await database.db.query<{ id: string; revoked_at: Date | null }>(
          "select id, revoked_at from sessions where user_id = $1",
          [userId],
        );
        expect(afterExtra.rows).toHaveLength(loginCount + 1);
        expect(afterExtra.rows.find((row) => row.id === expectedVictim)?.revoked_at).not.toBeNull();
        expect(afterExtra.rows.filter((row) => row.revoked_at === null)).toHaveLength(
          MAX_ACTIVE_SESSIONS,
        );
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        let cleanupError: unknown;
        try {
          await cleanup(
            database.db,
            discordId,
            attempts.map((attempt) => hashOAuthState(attempt.state, TEST_SESSION_SECRET)),
          );
        } catch (error) {
          cleanupError = error;
        }
        await database.close();
        if (primaryError === undefined && cleanupError) throw cleanupError;
      }
    },
  );
});
