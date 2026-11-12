import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpaqueToken, hashOAuthState } from "@/modules/auth/crypto";
import { hashSessionToken } from "@/modules/auth/crypto";
import { constantTimeEqualString } from "@/db/hashing";
import {
  consumeOAuthState,
  createOAuthState,
  deleteExpiredOAuthStates,
} from "@/modules/auth/oauth-state-store";
import { clearCookie, parseCookies, readCookie, serializeCookie } from "@/modules/auth/cookies";
import { absoluteRedirect, safeRedirectPath } from "@/modules/auth/redirect";
import { SESSION_COOKIE } from "@/modules/auth/config";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

const NOW = new Date("2026-01-01T00:00:00.000Z");

async function insertState(
  options: { state?: string; ttlMs?: number; now?: Date; redirectPath?: string } = {},
) {
  const state = options.state ?? createOpaqueToken();
  const now = options.now ?? NOW;
  await createOAuthState(database.db, {
    stateHash: hashOAuthState(state, "test-secret"),
    codeVerifier: "verifier-value",
    redirectPath: options.redirectPath ?? "/dashboard",
    now,
    ttlMs: options.ttlMs ?? 600_000,
  });
  return state;
}

describe("OAuth state store", () => {
  it("consumes a state exactly once", async () => {
    const state = await insertState();
    const first = await consumeOAuthState(database.db, hashOAuthState(state, "test-secret"), NOW);
    expect(first?.codeVerifier).toBe("verifier-value");
    expect(first?.redirectPath).toBe("/dashboard");

    const replay = await consumeOAuthState(database.db, hashOAuthState(state, "test-secret"), NOW);
    expect(replay).toBeNull();
  });

  it("stores only a hash, never the raw state", async () => {
    const state = await insertState();
    const result = await database.db.query<{ state_hash: string }>(
      "select state_hash from oauth_states where state_hash = $1",
      [hashOAuthState(state, "test-secret")],
    );
    expect(result.rows).toHaveLength(1);
    const raw = await database.db.query(
      "select state_hash from oauth_states where state_hash = $1",
      [state],
    );
    expect(raw.rows).toHaveLength(0);
  });

  it("rejects an unknown state", async () => {
    const consumed = await consumeOAuthState(
      database.db,
      hashOAuthState(createOpaqueToken(), "test-secret"),
      NOW,
    );
    expect(consumed).toBeNull();
  });

  it("rejects a state bound to a different secret", async () => {
    const state = await insertState();
    const consumed = await consumeOAuthState(
      database.db,
      hashOAuthState(state, "other-secret"),
      NOW,
    );
    expect(consumed).toBeNull();
  });

  it("rejects an expired state and leaves it unconsumed", async () => {
    const state = await insertState({ ttlMs: 1_000 });
    const later = new Date(NOW.getTime() + 2_000);
    const consumed = await consumeOAuthState(
      database.db,
      hashOAuthState(state, "test-secret"),
      later,
    );
    expect(consumed).toBeNull();
  });

  it("cleans up expired and consumed rows", async () => {
    await insertState({ ttlMs: 1_000 });
    const consumedState = await insertState();
    await consumeOAuthState(database.db, hashOAuthState(consumedState, "test-secret"), NOW);
    const removed = await deleteExpiredOAuthStates(database.db, NOW);
    expect(removed).toBeGreaterThan(0);
  });
});

describe("constant-time string comparison", () => {
  it("accepts equal non-empty strings and rejects everything else", () => {
    expect(constantTimeEqualString("abc", "abc")).toBe(true);
    expect(constantTimeEqualString("abc", "abd")).toBe(false);
    expect(constantTimeEqualString("abc", "abcd")).toBe(false);
    expect(constantTimeEqualString("", "")).toBe(false);
  });

  it("never treats a hash as equal to the token it hashes", () => {
    const token = createOpaqueToken();
    expect(constantTimeEqualString(hashSessionToken(token, "s"), token)).toBe(false);
  });
});

describe("cookie serialization", () => {
  it("marks the session cookie HttpOnly, SameSite=Lax, and scoped", () => {
    const cookie = serializeCookie(SESSION_COOKIE, "value", {
      secure: true,
      maxAgeSeconds: 3600,
      path: "/",
    });
    expect(cookie).toContain("bf_session=value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("omits Secure on a plain-http localhost origin", () => {
    const cookie = serializeCookie(SESSION_COOKIE, "value", {
      secure: false,
      maxAgeSeconds: 60,
    });
    expect(cookie).not.toContain("Secure");
  });

  it("can issue a non-HttpOnly CSRF cookie", () => {
    const cookie = serializeCookie("bf_csrf", "value", {
      secure: false,
      httpOnly: false,
      maxAgeSeconds: 60,
    });
    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("clears a cookie with Max-Age=0", () => {
    const cookie = clearCookie(SESSION_COOKIE, { secure: true, path: "/" });
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("bf_session=");
  });

  it("parses a Cookie header and ignores malformed pairs", () => {
    const parsed = parseCookies("a=1; b=2; broken; =nope; c=");
    expect(parsed).toEqual({ a: "1", b: "2" });
  });

  it("reads a named cookie from a request", () => {
    const request = new Request("http://localhost/", {
      headers: { cookie: "bf_session=token-value; bf_csrf=csrf-value" },
    });
    expect(readCookie(request, SESSION_COOKIE)).toBe("token-value");
    expect(readCookie(request, "missing")).toBeNull();
  });
});

describe("redirect allowlist", () => {
  it("accepts same-origin absolute paths", () => {
    expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
    expect(safeRedirectPath("/keys/abc?tab=usage")).toBe("/keys/abc?tab=usage");
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
  });

  it("rejects open-redirect attempts", () => {
    for (const attempt of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/path\nwith-newline",
      `/${"a".repeat(600)}`,
    ]) {
      expect(safeRedirectPath(attempt)).toBe("/");
    }
  });

  it("builds an absolute redirect from the app URL", () => {
    expect(absoluteRedirect("http://localhost:3000", "/dashboard")).toBe(
      "http://localhost:3000/dashboard",
    );
    expect(absoluteRedirect("http://localhost:3000/", "//evil.example")).toBe(
      "http://localhost:3000/",
    );
  });
});
