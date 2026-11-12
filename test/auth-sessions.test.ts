import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_SESSIONS,
  SESSION_COOKIE,
  SESSION_METADATA_RETENTION_MS,
} from "@/modules/auth/config";
import {
  cookieValue,
  createAuthHarness,
  loginThroughService,
  setCookieFor,
  type AuthHarness,
} from "./helpers/auth";
import { BASE, createHttpHarness, listSessions, ORIGIN, performLogin } from "./helpers/http";

function sessionCookieFrom(cookies: readonly string[]): string {
  const token = cookieValue(cookies, SESSION_COOKIE);
  if (!token) throw new Error("login did not return a session cookie");
  return `${SESSION_COOKIE}=${token}`;
}

async function sessionCookiesFor(harness: AuthHarness, count: number): Promise<string[]> {
  const cookies: string[] = [];
  for (let index = 0; index < count; index += 1) {
    harness.clock.advance(1000);
    const { result } = await loginThroughService(harness.service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("login failed");
    cookies.push(sessionCookieFrom(result.cookies));
  }
  return cookies;
}

async function resolves(harness: AuthHarness, cookie: string): Promise<boolean> {
  const session = await harness.service.resolveSession(
    new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
  );
  return session !== null;
}

describe("session cap", () => {
  it("evicts the oldest active session when a sixth login arrives", async () => {
    const harness = await createAuthHarness();
    try {
      const cookies = await sessionCookiesFor(harness, MAX_ACTIVE_SESSIONS + 1);
      const oldest = cookies[0]!;
      const newest = cookies[cookies.length - 1]!;

      const rows = await harness.db.query<{ revoked_at: Date | null }>(
        "select revoked_at from sessions order by created_at asc, id asc",
      );
      expect(rows.rows).toHaveLength(MAX_ACTIVE_SESSIONS + 1);
      expect(rows.rows[0]!.revoked_at).not.toBeNull();
      expect(rows.rows.filter((row) => row.revoked_at === null)).toHaveLength(MAX_ACTIVE_SESSIONS);

      expect(await resolves(harness, oldest)).toBe(false);
      expect(await resolves(harness, newest)).toBe(true);

      const audit = await harness.db.query<{ metadata: unknown }>(
        "select metadata from audit_logs where action = 'auth.session_limit_enforced'",
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({
        revokedSessions: 1,
        maxSessions: MAX_ACTIVE_SESSIONS,
      });
    } finally {
      await harness.close();
    }
  });

  it("never leaves more than the cap active under concurrent logins", async () => {
    // PGlite serializes transactions behind one mutex, so this asserts the
    // invariant but cannot independently prove PostgreSQL row-lock contention.
    const harness = await createAuthHarness();
    try {
      const results = await Promise.all(
        Array.from({ length: MAX_ACTIVE_SESSIONS + 3 }, () => loginThroughService(harness.service)),
      );
      expect(results.every(({ result }) => result.ok)).toBe(true);

      const active = await harness.db.query<{ count: number }>(
        `select count(*)::int as count
           from sessions
          where revoked_at is null
            and expires_at > $1
            and (absolute_expires_at is null or absolute_expires_at > $1)`,
        [harness.clock.now().toISOString()],
      );
      expect(active.rows[0]!.count).toBe(MAX_ACTIVE_SESSIONS);

      const all = await harness.db.query("select id from sessions");
      expect(all.rows).toHaveLength(MAX_ACTIVE_SESSIONS + 3);
    } finally {
      await harness.close();
    }
  });

  it("keeps revoked sessions when the raw metadata retention window passes", async () => {
    const harness = await createAuthHarness();
    try {
      await sessionCookiesFor(harness, MAX_ACTIVE_SESSIONS + 1);
      harness.clock.advance(SESSION_METADATA_RETENTION_MS + 1000);
      const rows = await harness.db.query("select id from sessions");
      expect(rows.rows).toHaveLength(MAX_ACTIVE_SESSIONS + 1);
    } finally {
      await harness.close();
    }
  });
});

describe("session listing", () => {
  it("lists only the current user's active sessions with safe fields", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const first = await performLogin(handler);

      harness.discord.profile.id = "999999999999999999";
      harness.discord.profile.username = "other";
      harness.discord.profile.globalName = "Other";
      const second = await performLogin(handler);

      const response = await listSessions(handler, first.cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.sessions).toHaveLength(1);
      const [session] = body.sessions;
      expect(session.current).toBe(true);
      expect(session.device).toBe("Chrome on Windows");
      expect(Object.keys(session).sort()).toEqual(
        [
          "absoluteExpiresAt",
          "createdAt",
          "current",
          "device",
          "expiresAt",
          "id",
          "lastSeenAt",
        ].sort(),
      );
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("127.0.0.1");
      expect(serialized).not.toContain("Mozilla/5.0");
      expect(serialized).not.toContain(first.session);

      const other = await listSessions(handler, second.cookie);
      const otherBody = await other.json();
      expect(otherBody.sessions).toHaveLength(1);
      expect(otherBody.sessions[0].id).not.toBe(session.id);
    } finally {
      await harness.close();
    }
  });

  it("requires authentication", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const response = await handler.call(null, new Request(`${BASE}/api/auth/sessions`), [
        "auth",
        "sessions",
      ]);
      expect(response.status).toBe(401);
    } finally {
      await harness.close();
    }
  });
});

describe("session revocation", () => {
  it("revokes another owned session and keeps the current one alive", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const first = await performLogin(handler);
      const second = await performLogin(handler);

      const listed = await (await listSessions(handler, second.cookie)).json();
      const firstId = listed.sessions.find((session: { current: boolean }) => !session.current)
        .id as string;

      const revoke = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${firstId}`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: second.cookie,
            "x-csrf-token": second.csrf,
          },
        }),
        ["auth", "sessions", firstId],
      );
      expect(revoke.status).toBe(200);
      const body = await revoke.json();
      expect(body).toEqual({ ok: true, current: false });

      const firstAfter = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: first.cookie } }),
        ["auth", "session"],
      );
      expect(firstAfter.status).toBe(401);
      const secondAfter = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: second.cookie } }),
        ["auth", "session"],
      );
      expect(secondAfter.status).toBe(200);

      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where action = 'auth.session_revoked'",
      );
      expect(audit.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("self-revocation clears cookies and the session fails on the next request", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie, csrf } = await performLogin(handler);
      const listed = await (await listSessions(handler, cookie)).json();
      const id = listed.sessions[0].id as string;

      const revoke = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${id}`, {
          method: "DELETE",
          headers: { origin: ORIGIN, cookie, "x-csrf-token": csrf },
        }),
        ["auth", "sessions", id],
      );
      expect(revoke.status).toBe(200);
      expect(await revoke.json()).toEqual({ ok: true, current: true });

      const cookies = revoke.headers.getSetCookie();
      expect(setCookieFor(cookies, SESSION_COOKIE)).toContain("Max-Age=0");
      expect(cookies.filter((line) => line.startsWith(`${SESSION_COOKIE}=`))).toHaveLength(1);

      const after = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
        ["auth", "session"],
      );
      expect(after.status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("returns a uniform 404 for foreign, missing, and already-revoked ids", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const owner = await performLogin(handler);

      harness.discord.profile.id = "999999999999999999";
      harness.discord.profile.username = "other";
      harness.discord.profile.globalName = "Other";
      const intruder = await performLogin(handler);

      const ownerList = await (await listSessions(handler, owner.cookie)).json();
      const ownerId = ownerList.sessions[0].id as string;

      const foreign = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${ownerId}`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: intruder.cookie,
            "x-csrf-token": intruder.csrf,
          },
        }),
        ["auth", "sessions", ownerId],
      );
      expect(foreign.status).toBe(404);
      const foreignBody = await foreign.json();
      expect(foreignBody.error.code).toBe("not_found");

      const missing = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/00000000-0000-4000-8000-000000000000`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: intruder.cookie,
            "x-csrf-token": intruder.csrf,
          },
        }),
        ["auth", "sessions", "00000000-0000-4000-8000-000000000000"],
      );
      expect(missing.status).toBe(404);

      const ownerAfter = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: owner.cookie } }),
        ["auth", "session"],
      );
      expect(ownerAfter.status).toBe(200);

      const revoked = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${ownerId}`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: owner.cookie,
            "x-csrf-token": owner.csrf,
          },
        }),
        ["auth", "sessions", ownerId],
      );
      expect(revoked.status).toBe(200);

      const again = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${ownerId}`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: intruder.cookie,
            "x-csrf-token": intruder.csrf,
          },
        }),
        ["auth", "sessions", ownerId],
      );
      expect(again.status).toBe(404);

      const malformed = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/not-a-uuid`, {
          method: "DELETE",
          headers: {
            origin: ORIGIN,
            cookie: intruder.cookie,
            "x-csrf-token": intruder.csrf,
          },
        }),
        ["auth", "sessions", "not-a-uuid"],
      );
      expect(malformed.status).toBe(400);
    } finally {
      await harness.close();
    }
  });

  it("requires CSRF for revocation", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie } = await performLogin(handler);
      const listed = await (await listSessions(handler, cookie)).json();
      const id = listed.sessions[0].id as string;

      const response = await handler.call(
        null,
        new Request(`${BASE}/api/auth/sessions/${id}`, {
          method: "DELETE",
          headers: { origin: ORIGIN, cookie },
        }),
        ["auth", "sessions", id],
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });
});

describe("suspended accounts", () => {
  it("rejects an existing session after the account is suspended", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie } = await performLogin(handler);

      await harness.db.query("update users set status = 'suspended'");

      const response = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
        ["auth", "session"],
      );
      expect(response.status).toBe(401);
    } finally {
      await harness.close();
    }
  });
});
