import { describe, expect, it } from "vitest";

import { CSRF_COOKIE, SESSION_COOKIE, SESSION_IDLE_MS } from "@/modules/auth/config";
import { hashSessionToken } from "@/modules/auth/crypto";
import { readPageSession, type CookieReader, type PageSession } from "@/modules/auth/page-session";
import {
  cookieValue,
  createAuthHarness,
  loginThroughService,
  TEST_SESSION_SECRET,
  type AuthHarness,
} from "./helpers/auth";

function cookieStore(values: Record<string, string>): CookieReader {
  return {
    get(name) {
      const value = values[name];
      return value === undefined ? undefined : { value };
    },
  };
}

interface LoginFixture {
  token: string;
  csrf: string;
  userId: string;
}

async function login(harness: AuthHarness): Promise<LoginFixture> {
  const loginResult = await loginThroughService(harness.service);
  if (!loginResult.result.ok) throw new Error("login failed");

  const token = cookieValue(loginResult.result.cookies, SESSION_COOKIE);
  const csrf = cookieValue(loginResult.result.cookies, CSRF_COOKIE);
  if (!token || !csrf) throw new Error("login did not return both auth cookies");

  return { token, csrf, userId: loginResult.result.userId };
}

async function read(
  harness: AuthHarness,
  values: Record<string, string>,
  now: Date = harness.clock.now(),
): Promise<PageSession | null> {
  return readPageSession(cookieStore(values), {
    db: harness.db,
    sessionSecret: TEST_SESSION_SECRET,
    now,
    ownerDiscordId: harness.ownerDiscordId,
  });
}

describe("page session lookup", () => {
  it("returns null when the session cookie is missing", async () => {
    const harness = await createAuthHarness();
    try {
      expect(await read(harness, {})).toBeNull();
      expect(await read(harness, { [CSRF_COOKIE]: "csrf-without-session" })).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("returns safe user data, database roles, and the current CSRF cookie", async () => {
    const harness = await createAuthHarness();
    try {
      const { token, csrf, userId } = await login(harness);
      await harness.db.query(
        "insert into user_roles (user_id, role, created_at) values ($1, 'moderator', $2)",
        [userId, harness.clock.now().toISOString()],
      );

      const session = await read(harness, {
        [SESSION_COOKIE]: token,
        [CSRF_COOKIE]: csrf,
      });

      expect(session).not.toBeNull();
      expect(session!.userId).toBe(userId);
      expect(session!.user).toEqual({
        id: userId,
        discordId: harness.discord.profile.id,
        username: "Tester",
        avatarUrl: null,
      });
      expect([...session!.roles].sort()).toEqual(["moderator", "user"]);
      expect(session!.csrfToken).toBe(csrf);
      expect(session!.expiresAt).toBe(
        new Date(harness.clock.now().getTime() + SESSION_IDLE_MS).toISOString(),
      );
      expect(Object.keys(session!).sort()).toEqual([
        "csrfToken",
        "expiresAt",
        "roles",
        "sessionId",
        "user",
        "userId",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("derives the owner role from the verified Discord id", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      const { token, userId } = await login(harness);
      const session = await read(harness, { [SESSION_COOKIE]: token });

      expect(session).not.toBeNull();
      expect([...session!.roles].sort()).toEqual(["owner", "user"]);

      const persisted = await harness.db.query<{ role: string }>(
        "select role from user_roles where user_id = $1 and role = 'owner'",
        [userId],
      );
      expect(persisted.rows).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("does not derive owner for a different id or missing configuration", async () => {
    const mismatched = await createAuthHarness({ ownerDiscordId: "999988887777666655" });
    const unconfigured = await createAuthHarness();
    try {
      const first = await login(mismatched);
      const firstSession = await read(mismatched, { [SESSION_COOKIE]: first.token });
      expect(firstSession!.roles).toEqual(["user"]);

      const second = await login(unconfigured);
      const secondSession = await read(unconfigured, { [SESSION_COOKIE]: second.token });
      expect(secondSession!.roles).toEqual(["user"]);
    } finally {
      await mismatched.close();
      await unconfigured.close();
    }
  });

  it("never returns the raw session token or its hash", async () => {
    const harness = await createAuthHarness();
    try {
      const { token } = await login(harness);
      const session = await read(harness, { [SESSION_COOKIE]: token });

      expect(session).not.toBeNull();
      const serialized = JSON.stringify(session);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(hashSessionToken(token, TEST_SESSION_SECRET));
      expect(session).not.toHaveProperty("token");
      expect(session).not.toHaveProperty("tokenHash");
    } finally {
      await harness.close();
    }
  });

  it("returns null for an expired idle session", async () => {
    const harness = await createAuthHarness();
    try {
      const { token } = await login(harness);
      const now = harness.clock.now();
      await harness.db.query("update sessions set expires_at = $1", [
        new Date(now.getTime() - 1000).toISOString(),
      ]);

      expect(await read(harness, { [SESSION_COOKIE]: token }, now)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("returns null when the absolute lifetime has passed", async () => {
    const harness = await createAuthHarness();
    try {
      const { token } = await login(harness);
      const now = harness.clock.now();
      await harness.db.query("update sessions set absolute_expires_at = $1", [
        new Date(now.getTime() - 1000).toISOString(),
      ]);

      expect(await read(harness, { [SESSION_COOKIE]: token }, now)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("returns null for a revoked session", async () => {
    const harness = await createAuthHarness();
    try {
      const { token } = await login(harness);
      await harness.db.query("update sessions set revoked_at = $1", [
        harness.clock.now().toISOString(),
      ]);

      expect(await read(harness, { [SESSION_COOKIE]: token })).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("returns null for a suspended account", async () => {
    const harness = await createAuthHarness();
    try {
      const { token, userId } = await login(harness);
      await harness.db.query("update users set status = 'suspended' where id = $1", [userId]);

      expect(await read(harness, { [SESSION_COOKIE]: token })).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("returns null when the user record is gone", async () => {
    const harness = await createAuthHarness();
    try {
      const { token, userId } = await login(harness);
      await harness.db.query("delete from audit_logs where actor_user_id = $1", [userId]);
      await harness.db.query("delete from users where id = $1", [userId]);

      expect(await read(harness, { [SESSION_COOKIE]: token })).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("does not mutate session rows or extend the idle window", async () => {
    const harness = await createAuthHarness();
    try {
      const { token, csrf, userId } = await login(harness);
      const session = await read(harness, { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf });
      expect(session).not.toBeNull();

      const row = await harness.db.query<{
        token_hash: string;
        last_seen_at: Date;
        expires_at: Date;
        rotated_at: Date | null;
        revoked_at: Date | null;
      }>(
        "select token_hash, last_seen_at, expires_at, rotated_at, revoked_at from sessions where user_id = $1",
        [userId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.last_seen_at).toEqual(harness.clock.now());
      expect(row.rows[0]!.rotated_at).toBeNull();
      expect(row.rows[0]!.revoked_at).toBeNull();
      expect(row.rows[0]!.expires_at).toEqual(
        new Date(harness.clock.now().getTime() + 24 * 60 * 60 * 1000),
      );
      expect(row.rows[0]!.token_hash).toBe(hashSessionToken(token, TEST_SESSION_SECRET));
    } finally {
      await harness.close();
    }
  });

  it("returns a null CSRF token when the CSRF cookie is absent", async () => {
    const harness = await createAuthHarness();
    try {
      const { token } = await login(harness);
      const session = await read(harness, { [SESSION_COOKIE]: token });

      expect(session).not.toBeNull();
      expect(session!.csrfToken).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
