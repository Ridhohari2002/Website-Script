import { describe, expect, it } from "vitest";
import { CSRF_COOKIE, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import { createCodeChallenge, hashSessionToken } from "@/modules/auth/crypto";
import { createLogger } from "@/core/logger";
import {
  cookieValue,
  createAuthHarness,
  createMockDiscord,
  loginThroughService,
  setCookieFor,
  TEST_SESSION_SECRET,
  type MockDiscordOptions,
} from "./helpers/auth";
import { trustedProxyHeaders } from "./helpers/proxy";

function callbackFor(state: string, options: { code?: string; cookieState?: string } = {}) {
  const code = options.code ?? "test-authorization-code";
  const cookieState = options.cookieState ?? state;
  return {
    request: new Request(
      `http://localhost:3000/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${cookieState}`,
          "user-agent": "vitest",
          ...trustedProxyHeaders("203.0.113.9"),
        },
      },
    ),
    code,
    state,
    oauthError: null,
  };
}

describe("Discord callback success", () => {
  it("creates the user from the Discord profile and issues an opaque session", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service, {
        next: "/dashboard",
        ip: "203.0.113.9",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.location).toBe("http://localhost:3000/dashboard");
      const token = cookieValue(result.cookies, SESSION_COOKIE);
      const csrf = cookieValue(result.cookies, CSRF_COOKIE);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(csrf).toMatch(/^[0-9a-f]{64}$/);

      const sessionCookie = setCookieFor(result.cookies, SESSION_COOKIE);
      expect(sessionCookie).toContain("HttpOnly");
      expect(sessionCookie).toContain("SameSite=Lax");
      expect(sessionCookie).toContain("Path=/");
      expect(sessionCookie).toContain("Max-Age=604800");
      expect(sessionCookie).not.toContain("Secure");

      const users = await harness.db.query<{ id: string; discord_id: string; username: string }>(
        "select id, discord_id, username from users",
      );
      expect(users.rows).toHaveLength(1);
      expect(users.rows[0]!.discord_id).toBe("111122223333444455");
      expect(users.rows[0]!.username).toBe("Tester");

      const roles = await harness.db.query<{ role: string }>("select role from user_roles");
      expect(roles.rows.map((row) => row.role)).toEqual(["user"]);

      const sessions = await harness.db.query<{ token_hash: string; ip: string }>(
        "select token_hash, ip from sessions",
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]!.token_hash).toBe(hashSessionToken(token!, TEST_SESSION_SECRET));
      expect(sessions.rows[0]!.token_hash).not.toBe(token);
      expect(sessions.rows[0]!.ip).toBe("203.0.113.9");

      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where action = 'auth.login'",
      );
      expect(audit.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("uses Secure cookies when configured for https", async () => {
    const harness = await createAuthHarness({ secureCookies: true });
    try {
      const { result } = await loginThroughService(harness.service);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(setCookieFor(result.cookies, SESSION_COOKIE)).toContain("Secure");
      expect(setCookieFor(result.cookies, CSRF_COOKIE)).toContain("Secure");
      expect(setCookieFor(result.cookies, CSRF_COOKIE)).not.toContain("HttpOnly");
    } finally {
      await harness.close();
    }
  });

  it("keeps one user row and refreshes display fields on a later login", async () => {
    const harness = await createAuthHarness();
    try {
      await loginThroughService(harness.service);
      harness.discord.profile.username = "renamed";
      harness.discord.profile.globalName = null;
      const second = await loginThroughService(harness.service);
      expect(second.result.ok).toBe(true);

      const users = await harness.db.query<{ username: string }>("select username from users");
      expect(users.rows).toHaveLength(1);
      expect(users.rows[0]!.username).toBe("renamed");

      const sessions = await harness.db.query("select id from sessions");
      expect(sessions.rows).toHaveLength(2);

      const roles = await harness.db.query("select id from user_roles");
      expect(roles.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("sends the stored PKCE verifier and a matching S256 challenge", async () => {
    const options: MockDiscordOptions = {};
    const discord = createMockDiscord(options);
    const harness = await createAuthHarness({ discord });
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const verifierRow = await harness.db.query<{ code_verifier: string }>(
        "select code_verifier from oauth_states",
      );
      const verifier = verifierRow.rows[0]!.code_verifier;

      const url = new URL(start.location);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBe(createCodeChallenge(verifier));

      // The mock enforces the verifier exactly as Discord should. This proves our
      // exchange includes the stored verifier; it does not prove Discord enforces it.
      options.expectedVerifier = verifier;
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;
      const result = await harness.service.completeLogin(callbackFor(state));
      expect(result.ok).toBe(true);
      expect(discord.calls.exchange[0]?.codeVerifier).toBe(verifier);
    } finally {
      await harness.close();
    }
  });

  it("does not persist or log Discord tokens, the code, the state, or the secret", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
    const harness = await createAuthHarness({ logger });
    try {
      const { result, state } = await loginThroughService(harness.service);
      expect(result.ok).toBe(true);

      const dump = await harness.db.query<{ data: string }>(
        `select coalesce(string_agg(t::text, ' '), '') as data from (
           select row_to_json(u)::text as t from users u
           union all select row_to_json(s)::text from sessions s
           union all select row_to_json(a)::text from audit_logs a
         ) rows`,
      );
      const stored = dump.rows[0]?.data ?? "";
      for (const secret of [
        "mock-discord-access-token",
        "test-client-secret-not-real",
        "test-authorization-code",
        state,
      ]) {
        expect(stored).not.toContain(secret);
        expect(lines.join("\n")).not.toContain(secret);
      }
    } finally {
      await harness.close();
    }
  });
});

describe("Discord callback failures", () => {
  it("rejects a missing state without creating a session", async () => {
    const harness = await createAuthHarness();
    try {
      const result = await harness.service.completeLogin({
        request: new Request("http://localhost:3000/api/auth/callback?code=abc"),
        code: "abc",
        state: null,
        oauthError: null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_state");
      expect(result.location).toBe("http://localhost:3000/?auth_error=invalid_state");
      const sessions = await harness.db.query("select id from sessions");
      expect(sessions.rows).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects a state that does not match the browser binding cookie", async () => {
    const harness = await createAuthHarness();
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;
      const result = await harness.service.completeLogin(
        callbackFor(state, { cookieState: "some-other-state" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_state");
    } finally {
      await harness.close();
    }
  });

  it("rejects a replayed callback", async () => {
    const harness = await createAuthHarness();
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;

      const first = await harness.service.completeLogin(callbackFor(state));
      expect(first.ok).toBe(true);

      const replay = await harness.service.completeLogin(callbackFor(state));
      expect(replay.ok).toBe(false);
      if (replay.ok) return;
      expect(replay.reason).toBe("invalid_state");

      const sessions = await harness.db.query("select id from sessions");
      expect(sessions.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired state", async () => {
    const harness = await createAuthHarness();
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;
      harness.clock.advance(11 * 60 * 1000);
      const result = await harness.service.completeLogin(callbackFor(state));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_state");
    } finally {
      await harness.close();
    }
  });

  it("maps a provider exchange failure to oauth_failed", async () => {
    const harness = await createAuthHarness({
      discord: createMockDiscord({ exchangeError: true }),
    });
    try {
      const { result } = await loginThroughService(harness.service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("oauth_failed");
      const sessions = await harness.db.query("select id from sessions");
      expect(sessions.rows).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("maps a profile failure to oauth_failed", async () => {
    const harness = await createAuthHarness({ discord: createMockDiscord({ profileError: true }) });
    try {
      const { result } = await loginThroughService(harness.service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("oauth_failed");
    } finally {
      await harness.close();
    }
  });

  it("treats a cancelled consent screen as oauth_failed", async () => {
    const harness = await createAuthHarness();
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;
      const result = await harness.service.completeLogin({
        request: new Request(
          `http://localhost:3000/api/auth/callback?error=access_denied&state=${state}`,
          { headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` } },
        ),
        code: null,
        state,
        oauthError: "access_denied",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("oauth_failed");
    } finally {
      await harness.close();
    }
  });

  it("refuses a suspended account and audits the failed login", async () => {
    const harness = await createAuthHarness();
    try {
      await harness.db.query(
        "insert into users (discord_id, status) values ('111122223333444455', 'suspended')",
      );
      const { result } = await loginThroughService(harness.service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("account_disabled");

      const sessions = await harness.db.query("select id from sessions");
      expect(sessions.rows).toHaveLength(0);
      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where action = 'auth.login_failed'",
      );
      expect(audit.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("ignores client-supplied identity and uses the provider id", async () => {
    const harness = await createAuthHarness();
    try {
      const start = await harness.service.startLogin({ next: "/" });
      const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE)!;
      const request = new Request(
        `http://localhost:3000/api/auth/callback?code=abc&state=${state}&discord_id=999999999999999999`,
        {
          headers: {
            cookie: `${OAUTH_STATE_COOKIE}=${state}; discord_id=999999999999999999`,
            "x-discord-id": "999999999999999999",
            "x-role": "admin",
          },
        },
      );
      const result = await harness.service.completeLogin({
        request,
        code: "abc",
        state,
        oauthError: null,
      });
      expect(result.ok).toBe(true);
      const users = await harness.db.query<{ discord_id: string }>(
        "select discord_id from users order by discord_id",
      );
      expect(users.rows.map((row) => row.discord_id)).toEqual(["111122223333444455"]);
      const roles = await harness.db.query<{ role: string }>("select role from user_roles");
      expect(roles.rows.map((row) => row.role)).toEqual(["user"]);
    } finally {
      await harness.close();
    }
  });

  it("rejects a provider profile whose id is not a snowflake", async () => {
    const harness = await createAuthHarness({
      discord: createMockDiscord({ profile: { id: "not-a-snowflake" } }),
    });
    try {
      const { result } = await loginThroughService(harness.service);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("oauth_failed");
    } finally {
      await harness.close();
    }
  });
});

describe("session resolution", () => {
  it("returns null for an unknown or forged cookie", async () => {
    const harness = await createAuthHarness();
    try {
      const session = await harness.service.resolveSession(
        new Request("http://localhost:3000/api/auth/session", {
          headers: { cookie: `${SESSION_COOKIE}=forged-token` },
        }),
      );
      expect(session).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("loads roles from the database on every request", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      const cookie = `${SESSION_COOKIE}=${cookieValue(result.cookies, SESSION_COOKIE)}`;

      const before = await harness.service.resolveSession(
        new Request("http://localhost:3000/api/auth/session", { headers: { cookie } }),
      );
      expect(before?.roles).toEqual(["user"]);

      await harness.db.query(
        "insert into user_roles (user_id, role) select id, 'admin' from users",
      );
      const after = await harness.service.resolveSession(
        new Request("http://localhost:3000/api/auth/session", { headers: { cookie } }),
      );
      expect(after?.roles.sort()).toEqual(["admin", "user"]);
    } finally {
      await harness.close();
    }
  });

  it("extends the idle window on activity but never past the absolute lifetime", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      const cookie = `${SESSION_COOKIE}=${cookieValue(result.cookies, SESSION_COOKIE)}`;

      harness.clock.advance(23 * 60 * 60 * 1000);
      const active = await harness.service.resolveSession(
        new Request("http://localhost:3000/", { headers: { cookie } }),
      );
      expect(active).not.toBeNull();

      const row = await harness.db.query<{ expires_at: Date; absolute_expires_at: Date }>(
        "select expires_at, absolute_expires_at from sessions",
      );
      const expiresAt = row.rows[0]!.expires_at.getTime();
      const absoluteExpiresAt = row.rows[0]!.absolute_expires_at.getTime();
      expect(expiresAt).toBe(harness.clock.now().getTime() + 24 * 60 * 60 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(absoluteExpiresAt);
    } finally {
      await harness.close();
    }
  });

  it("rejects an idle-expired session", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      const cookie = `${SESSION_COOKIE}=${cookieValue(result.cookies, SESSION_COOKIE)}`;

      harness.clock.advance(25 * 60 * 60 * 1000);
      const session = await harness.service.resolveSession(
        new Request("http://localhost:3000/", { headers: { cookie } }),
      );
      expect(session).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("rejects a session past its absolute lifetime even when recently active", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      let token = cookieValue(result.cookies, SESSION_COOKIE)!;

      for (let index = 0; index < 13; index += 1) {
        harness.clock.advance(12 * 60 * 60 * 1000);
        const active = await harness.service.resolveSession(
          new Request("http://localhost:3000/", {
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          }),
        );
        expect(active).not.toBeNull();
        // Rotation replaces the token; follow it like a browser would.
        const rotatedToken = cookieValue(active?.setCookies ?? [], SESSION_COOKIE);
        if (rotatedToken) token = rotatedToken;
      }
      harness.clock.advance(24 * 60 * 60 * 1000);
      const expired = await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        }),
      );
      expect(expired).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("rotates the token after 24 hours of use and invalidates the old one", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      const oldToken = cookieValue(result.cookies, SESSION_COOKIE)!;

      harness.clock.advance(12 * 60 * 60 * 1000);
      await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: { cookie: `${SESSION_COOKIE}=${oldToken}` },
        }),
      );

      harness.clock.advance(13 * 60 * 60 * 1000);
      const rotated = await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: { cookie: `${SESSION_COOKIE}=${oldToken}` },
        }),
      );
      expect(rotated?.setCookies?.length).toBeGreaterThan(0);
      const newToken = cookieValue(rotated!.setCookies!, SESSION_COOKIE)!;
      expect(newToken).not.toBe(oldToken);

      const oldSession = await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: { cookie: `${SESSION_COOKIE}=${oldToken}` },
        }),
      );
      expect(oldSession).toBeNull();

      const newSession = await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: { cookie: `${SESSION_COOKIE}=${newToken}` },
        }),
      );
      expect(newSession).not.toBeNull();

      const rows = await harness.db.query("select id from sessions");
      expect(rows.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("revokes one session immediately on logout", async () => {
    const harness = await createAuthHarness();
    try {
      const { result } = await loginThroughService(harness.service);
      if (!result.ok) throw new Error("login failed");
      const cookie = `${SESSION_COOKIE}=${cookieValue(result.cookies, SESSION_COOKIE)}`;

      const session = await harness.service.resolveSession(
        new Request("http://localhost:3000/", { headers: { cookie } }),
      );
      expect(session).not.toBeNull();

      await harness.service.logout({
        session: session!,
        request: new Request("http://localhost:3000/api/auth/logout", { method: "POST" }),
      });

      const after = await harness.service.resolveSession(
        new Request("http://localhost:3000/", { headers: { cookie } }),
      );
      expect(after).toBeNull();

      const row = await harness.db.query<{ revoked_at: Date | null }>(
        "select revoked_at from sessions",
      );
      expect(row.rows[0]!.revoked_at).not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("revokes every session on logout-all", async () => {
    const harness = await createAuthHarness();
    try {
      const first = await loginThroughService(harness.service);
      const second = await loginThroughService(harness.service);
      if (!first.result.ok || !second.result.ok) throw new Error("login failed");

      const firstSession = await harness.service.resolveSession(
        new Request("http://localhost:3000/", {
          headers: {
            cookie: `${SESSION_COOKIE}=${cookieValue(first.result.cookies, SESSION_COOKIE)}`,
          },
        }),
      );

      await harness.service.logoutAll({
        session: firstSession!,
        request: new Request("http://localhost:3000/api/auth/logout-all", { method: "POST" }),
      });

      for (const token of [
        cookieValue(first.result.cookies, SESSION_COOKIE)!,
        cookieValue(second.result.cookies, SESSION_COOKIE)!,
      ]) {
        const session = await harness.service.resolveSession(
          new Request("http://localhost:3000/", {
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          }),
        );
        expect(session).toBeNull();
      }

      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where action = 'auth.logout_all'",
      );
      expect(audit.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
