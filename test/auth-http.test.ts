import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { createAuthService } from "@/modules/auth/service";
import { CSRF_COOKIE, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import {
  createAuthHarness,
  cookieValue,
  setCookieFor,
  TEST_CONFIG,
  TEST_SESSION_SECRET,
} from "./helpers/auth";
import { BASE, createHttpHarness, ORIGIN, performLogin } from "./helpers/http";

afterAll(() => {
  resetEnvCache();
});

describe("authentication endpoints", () => {
  it("fails login closed when Discord is not configured", async () => {
    resetEnvCache();
    const database = await createAuthHarness();
    try {
      const unconfigured = createAuthService({
        db: database.db,
        clock: database.clock.now,
        sessionSecret: TEST_SESSION_SECRET,
        secureCookies: false,
      });
      const handler = createHttpHarness(unconfigured);
      const response = await handler.call(null, new Request(`${BASE}/api/auth/login`), [
        "auth",
        "login",
      ]);
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe("unavailable");
      expect(JSON.stringify(body)).not.toContain("DISCORD_CLIENT_SECRET");
      expect(JSON.stringify(body)).not.toContain("client-secret");
    } finally {
      await database.close();
      resetEnvCache();
    }
  });

  it("redirects to Discord with state, PKCE S256, identify scope, and a bound cookie", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/auth/login?next=/dashboard`),
        ["auth", "login"],
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);

      expect(location.origin).toBe("https://discord.com");
      expect(location.pathname).toBe("/api/oauth2/authorize");
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("client_id")).toBe(TEST_CONFIG.clientId);
      expect(location.searchParams.get("redirect_uri")).toBe(TEST_CONFIG.redirectUri);
      expect(location.searchParams.get("scope")).toBe("identify");
      expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.toString()).not.toContain("client_secret");

      const stateCookie = setCookieFor(response.headers.getSetCookie(), OAUTH_STATE_COOKIE);
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("SameSite=Lax");
      expect(stateCookie).toContain("Path=/api/auth");
      expect(stateCookie).toContain("Max-Age=600");
    } finally {
      await harness.close();
    }
  });

  it("rate limits login attempts", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service, { denyRateLimit: true });
      const response = await handler.call(null, new Request(`${BASE}/api/auth/login`), [
        "auth",
        "login",
      ]);
      expect(response.status).toBe(429);
    } finally {
      await harness.close();
    }
  });

  it("completes a round trip and reports the session", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie, csrf } = await performLogin(handler);

      const sessionResponse = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
        ["auth", "session"],
      );
      expect(sessionResponse.status).toBe(200);
      const body = await sessionResponse.json();
      expect(body.user.discordId).toBe("111122223333444455");
      expect(body.user.username).toBe("Tester");
      expect(body.roles).toEqual(["user"]);
      expect(body.csrfToken).toBe(csrf);
      expect(JSON.stringify(body)).not.toContain("mock-discord-access-token");
    } finally {
      await harness.close();
    }
  });

  it("reports owner only for the configured verified Discord id", async () => {
    const owner = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    const nonOwner = await createAuthHarness({ ownerDiscordId: "999988887777666655" });
    try {
      const ownerHandler = createHttpHarness(owner.service);
      const ownerLogin = await performLogin(ownerHandler);
      const ownerSession = await ownerHandler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: ownerLogin.cookie } }),
        ["auth", "session"],
      );
      expect(ownerSession.status).toBe(200);
      expect((await ownerSession.json()).roles).toEqual(["user", "owner"]);

      const nonOwnerHandler = createHttpHarness(nonOwner.service);
      const nonOwnerLogin = await performLogin(nonOwnerHandler);
      const nonOwnerSession = await nonOwnerHandler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: nonOwnerLogin.cookie } }),
        ["auth", "session"],
      );
      expect(nonOwnerSession.status).toBe(200);
      expect((await nonOwnerSession.json()).roles).toEqual(["user"]);
    } finally {
      await owner.close();
      await nonOwner.close();
    }
  });

  it("ignores client-supplied Discord ids and role claims", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "999988887777666655" });
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie } = await performLogin(handler);

      const response = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, {
          headers: {
            cookie,
            "x-discord-id": "999988887777666655",
            "x-user-id": "999988887777666655",
            "x-role": "owner",
            "x-roles": "owner,admin",
          },
        }),
        ["auth", "session"],
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.user.discordId).toBe("111122223333444455");
      expect(body.roles).toEqual(["user"]);
    } finally {
      await harness.close();
    }
  });

  it("lets owner through the admin route gate and still denies non-admins", async () => {
    const owner = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    const regular = await createAuthHarness();
    try {
      const ownerHandler = createHttpHarness(owner.service);
      const ownerLogin = await performLogin(ownerHandler);
      const ownerPing = await ownerHandler.call(
        null,
        new Request(`${BASE}/admin/ping`, { headers: { cookie: ownerLogin.cookie } }),
        ["admin", "ping"],
      );
      expect(ownerPing.status).toBe(200);

      const regularHandler = createHttpHarness(regular.service);
      const regularLogin = await performLogin(regularHandler);
      const regularPing = await regularHandler.call(
        null,
        new Request(`${BASE}/admin/ping`, { headers: { cookie: regularLogin.cookie } }),
        ["admin", "ping"],
      );
      expect(regularPing.status).toBe(403);

      const session = await regularHandler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie: regularLogin.cookie } }),
        ["auth", "session"],
      );
      const userId = (await session.json()).user.id as string;

      await regular.db.query(
        "insert into user_roles (user_id, role, created_at) values ($1, 'admin', $2)",
        [userId, regular.clock.now().toISOString()],
      );
      const adminPing = await regularHandler.call(
        null,
        new Request(`${BASE}/admin/ping`, { headers: { cookie: regularLogin.cookie } }),
        ["admin", "ping"],
      );
      expect(adminPing.status).toBe(200);
    } finally {
      await owner.close();
      await regular.close();
    }
  });

  it("requires a session for the session and logout endpoints", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const sessionResponse = await handler.call(null, new Request(`${BASE}/api/auth/session`), [
        "auth",
        "session",
      ]);
      expect(sessionResponse.status).toBe(401);

      const logout = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { origin: ORIGIN } }),
        ["auth", "logout"],
      );
      expect(logout.status).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("rejects logout without a valid CSRF token", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie } = await performLogin(handler);

      const missing = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie },
        }),
        ["auth", "logout"],
      );
      expect(missing.status).toBe(403);

      const wrong = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie, "x-csrf-token": "not-the-token" },
        }),
        ["auth", "logout"],
      );
      expect(wrong.status).toBe(403);

      const foreignOrigin = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: "https://evil.example", cookie },
        }),
        ["auth", "logout"],
      );
      expect(foreignOrigin.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("ignores a forged CSRF cookie and still requires the derived token", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie, csrf } = await performLogin(handler);
      const forgedCookie = `${cookie}; ${CSRF_COOKIE}=forged-value`;

      const forgedHeader = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            cookie: forgedCookie,
            "x-csrf-token": "forged-value",
          },
        }),
        ["auth", "logout"],
      );
      expect(forgedHeader.status).toBe(403);

      // The cookie is not trusted at all: the real token in the header works
      // even when the cookie value is forged.
      const realHeader = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie: forgedCookie, "x-csrf-token": csrf },
        }),
        ["auth", "logout"],
      );
      expect(realHeader.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("rejects logout-all without a valid CSRF token", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie } = await performLogin(handler);
      const noToken = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout-all`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie },
        }),
        ["auth", "logout-all"],
      );
      expect(noToken.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("rejects a state that does not match the browser cookie at the HTTP layer", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const login = await handler.call(null, new Request(`${BASE}/api/auth/login`), [
        "auth",
        "login",
      ]);
      const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE)!;

      const callback = await handler.call(
        null,
        new Request(`${BASE}/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `${OAUTH_STATE_COOKIE}=different-state` },
        }),
        ["auth", "callback"],
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`${BASE}/?auth_error=invalid_state`);
      expect(setCookieFor(callback.headers.getSetCookie(), SESSION_COOKIE)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired OAuth state at the HTTP layer", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const login = await handler.call(null, new Request(`${BASE}/api/auth/login`), [
        "auth",
        "login",
      ]);
      const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE)!;
      harness.clock.advance(11 * 60 * 1000);

      const callback = await handler.call(
        null,
        new Request(`${BASE}/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
        }),
        ["auth", "callback"],
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(`${BASE}/?auth_error=invalid_state`);
      expect(setCookieFor(callback.headers.getSetCookie(), SESSION_COOKIE)).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("rate limits the callback endpoint", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service, { denyRateLimit: true });
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/auth/callback?code=test-code&state=state`, {
          headers: { cookie: `${OAUTH_STATE_COOKIE}=state` },
        }),
        ["auth", "callback"],
      );
      expect(response.status).toBe(429);
    } finally {
      await harness.close();
    }
  });

  it("does not re-add a rotation cookie after logout clears the session", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie, csrf } = await performLogin(handler);

      // Touch at 23h so the idle window extends, then cross the 24h rotation
      // threshold without letting the session expire.
      harness.clock.advance(23 * 60 * 60 * 1000);
      const before = await handler.call(
        null,
        new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
        ["auth", "session"],
      );
      expect(before.status).toBe(200);
      harness.clock.advance(2 * 60 * 60 * 1000);

      const logout = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie, "x-csrf-token": csrf },
        }),
        ["auth", "logout"],
      );
      expect(logout.status).toBe(200);

      const sessionCookies = logout.headers
        .getSetCookie()
        .filter((line) => line.startsWith(`${SESSION_COOKIE}=`));
      expect(sessionCookies).toHaveLength(1);
      expect(sessionCookies[0]).toContain("Max-Age=0");

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

  it("logs out, clears cookies, and rejects the revoked session on the next request", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const { cookie, csrf } = await performLogin(handler);

      const logout = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie, "x-csrf-token": csrf },
        }),
        ["auth", "logout"],
      );
      expect(logout.status).toBe(200);
      const cleared = logout.headers.getSetCookie();
      expect(setCookieFor(cleared, SESSION_COOKIE)).toContain("Max-Age=0");
      expect(setCookieFor(cleared, CSRF_COOKIE)).toContain("Max-Age=0");

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

  it("logout-all revokes the other browser session too", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const first = await performLogin(handler);
      const second = await performLogin(handler);

      const logoutAll = await handler.call(
        null,
        new Request(`${BASE}/api/auth/logout-all`, {
          method: "POST",
          headers: { origin: ORIGIN, cookie: first.cookie, "x-csrf-token": first.csrf },
        }),
        ["auth", "logout-all"],
      );
      expect(logoutAll.status).toBe(200);

      for (const cookie of [first.cookie, second.cookie]) {
        const after = await handler.call(
          null,
          new Request(`${BASE}/api/auth/session`, { headers: { cookie } }),
          ["auth", "session"],
        );
        expect(after.status).toBe(401);
      }
    } finally {
      await harness.close();
    }
  });

  it("rejects a replayed callback at the HTTP layer", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const login = await handler.call(null, new Request(`${BASE}/api/auth/login`), [
        "auth",
        "login",
      ]);
      const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE)!;
      const callbackRequest = () =>
        new Request(`${BASE}/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
        });

      const first = await handler.call(null, callbackRequest(), ["auth", "callback"]);
      expect(first.status).toBe(302);

      const replay = await handler.call(null, callbackRequest(), ["auth", "callback"]);
      expect(replay.status).toBe(302);
      expect(replay.headers.get("location")).toBe(`${BASE}/?auth_error=invalid_state`);
      const cookies = replay.headers.getSetCookie();
      expect(setCookieFor(cookies, SESSION_COOKIE)).toBeNull();
    } finally {
      await harness.close();
    }
  });
});

describe("authorization boundary", () => {
  it("denies anonymous and non-admin access to an admin route", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);

      const anonymous = await handler.call(null, new Request(`${BASE}/api/admin/ping`), [
        "admin",
        "ping",
      ]);
      expect(anonymous.status).toBe(401);

      const { cookie } = await performLogin(handler);
      const denied = await handler.call(
        null,
        new Request(`${BASE}/api/admin/ping`, {
          headers: { cookie, "x-role": "admin", "x-discord-id": "999999999999999999" },
        }),
        ["admin", "ping"],
      );
      expect(denied.status).toBe(403);

      const denial = await harness.db.query<{ action: string }>(
        "select action from audit_logs where action = 'auth.authorization_denied'",
      );
      expect(denial.rows).toHaveLength(1);

      await harness.db.query(
        "insert into user_roles (user_id, role) select id, 'admin' from users",
      );
      const allowed = await handler.call(
        null,
        new Request(`${BASE}/api/admin/ping`, { headers: { cookie } }),
        ["admin", "ping"],
      );
      expect(allowed.status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("ignores a forged session cookie and a forged role header", async () => {
    const harness = await createAuthHarness();
    try {
      const handler = createHttpHarness(harness.service);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/admin/ping`, {
          headers: { cookie: `${SESSION_COOKIE}=forged`, "x-role": "admin" },
        }),
        ["admin", "ping"],
      );
      expect(response.status).toBe(401);
    } finally {
      await harness.close();
    }
  });
});
