import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthNavView, type AuthNavViewProps } from "@/components/site/auth-nav";
import {
  accountLabel,
  authStateFromPayload,
  loadAuthState,
  logoutOutcome,
  readCsrfToken,
  safeAvatarUrl,
  submitLogout,
} from "@/lib/auth-client";
import type { AuthNavState } from "@/lib/auth-client";

const VALID_AVATAR =
  "https://cdn.discordapp.com/avatars/123456789012345678/abcdef0123456789abcdef0123456789.png?size=128";

function renderView(state: AuthNavState, overrides: Partial<AuthNavViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(AuthNavView, {
      state,
      pathname: "/dashboard",
      signingOut: false,
      error: null,
      onSignOut: () => undefined,
      ...overrides,
    }),
  );
}

describe("auth-aware navigation rendering", () => {
  it("shows a loading state before the session request settles", () => {
    const html = renderView({ status: "loading" });

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Checking account status");
  });

  it("shows Sign in with a login link for anonymous visitors", () => {
    const html = renderView({ status: "anonymous" });

    expect(html).toContain("Sign in");
    expect(html).toContain('href="/api/auth/login?next=%2Fdashboard"');
  });

  it("shows the account entry and sign-out control for a signed-in user", () => {
    const html = renderView({
      status: "authenticated",
      user: { username: "Tester", avatarUrl: null },
    });

    expect(html).toContain("Tester");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Sign out");
  });

  it("shows a neutral account link when the session endpoint is unavailable", () => {
    const html = renderView({ status: "unavailable" });

    expect(html).toContain("Account");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain("Sign out");
  });

  it("renders a visible logout failure message", () => {
    const html = renderView(
      { status: "authenticated", user: { username: "Tester", avatarUrl: null } },
      { error: "Network error. Try signing out again." },
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Network error");
  });
});

describe("session response handling", () => {
  it("accepts only the trusted session shape and ignores roles", () => {
    const state = authStateFromPayload({
      user: { id: "user-1", discordId: "1", username: "Tester", avatarUrl: null },
      roles: ["admin"],
    });

    expect(state).toEqual({
      status: "authenticated",
      user: { username: "Tester", avatarUrl: null },
    });
    expect(state).not.toHaveProperty("roles");
  });

  it("fails closed for malformed payloads", () => {
    expect(authStateFromPayload(null)).toEqual({ status: "unavailable" });
    expect(authStateFromPayload({})).toEqual({ status: "unavailable" });
    expect(authStateFromPayload({ user: null })).toEqual({ status: "unavailable" });
    expect(authStateFromPayload({ user: { username: "Tester" } })).toEqual({
      status: "unavailable",
    });
  });

  it("loads a session with a no-store request", async () => {
    let captured: RequestInit | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Response.json({
        user: { id: "user-1", username: "Tester", avatarUrl: VALID_AVATAR },
      });
    }) as typeof fetch;

    const state = await loadAuthState(fetcher);

    expect(state).toEqual({
      status: "authenticated",
      user: { username: "Tester", avatarUrl: VALID_AVATAR },
    });
    expect(captured?.cache).toBe("no-store");
    expect(captured?.credentials).toBe("same-origin");
  });

  it("treats 401 as anonymous and other failures as unavailable", async () => {
    const unauthorized = (async () => new Response(null, { status: 401 })) as typeof fetch;
    const failing = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const offline = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    expect(await loadAuthState(unauthorized)).toEqual({ status: "anonymous" });
    expect(await loadAuthState(failing)).toEqual({ status: "unavailable" });
    expect(await loadAuthState(offline)).toEqual({ status: "unavailable" });
  });
});

describe("avatar URL policy", () => {
  it("accepts the Discord CDN HTTPS avatar host", () => {
    expect(safeAvatarUrl(VALID_AVATAR)).toBe(VALID_AVATAR);
  });

  it("rejects unsafe schemes, hosts, credentials, and malformed values", () => {
    const rejected: unknown[] = [
      "http://cdn.discordapp.com/avatars/1/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "blob:https://cdn.discordapp.com/abc",
      "/avatars/1/a.png",
      "//cdn.discordapp.com/avatars/1/a.png",
      "https://cdn.example/avatar.png",
      "https://cdn.discordapp.com.evil.example/avatar.png",
      "https://user:pass@cdn.discordapp.com/avatars/1/a.png",
      "https://cdn.discordapp.com:8443/avatars/1/a.png",
      "not a url",
      "",
      null,
      undefined,
    ];

    for (const candidate of rejected) {
      expect(safeAvatarUrl(candidate)).toBeNull();
    }
  });

  it("drops an invalid avatar from the session payload", () => {
    const state = authStateFromPayload({
      user: { id: "user-1", username: "Tester", avatarUrl: "https://cdn.example/avatar.png" },
    });

    expect(state).toEqual({
      status: "authenticated",
      user: { username: "Tester", avatarUrl: null },
    });
  });

  it("renders a valid Discord avatar", () => {
    const html = renderView({
      status: "authenticated",
      user: { username: "Tester", avatarUrl: VALID_AVATAR },
    });

    expect(html).toContain(`src="${VALID_AVATAR}"`);
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("falls back to initials when the avatar is unsafe", () => {
    const state = authStateFromPayload({
      user: { id: "user-1", username: "Tester", avatarUrl: "javascript:alert(1)" },
    });
    const html = renderView(state);

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain(">T<");
  });
});

describe("logout request", () => {
  it("posts to the existing endpoint with the current CSRF cookie", async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(input), init };
      return Response.json({ ok: true });
    }) as typeof fetch;

    const result = await submitLogout({
      fetchImpl,
      cookieSource: "bf_csrf=csrf-current; bf_session=not-read-here",
    });

    expect(result).toEqual({ ok: true, revoked: true });
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/api/auth/logout");
    expect(captured!.init?.method).toBe("POST");
    expect(captured!.init?.credentials).toBe("same-origin");
    expect(new Headers(captured!.init?.headers).get("x-csrf-token")).toBe("csrf-current");
  });

  it("does not call the endpoint when the CSRF cookie is missing", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const result = await submitLogout({ fetchImpl, cookieSource: "bf_session=only" });

    expect(result).toEqual({ ok: false, reason: "missing-csrf" });
    expect(called).toBe(false);
  });

  it("treats 401 as already unauthenticated, not as confirmed revocation", async () => {
    const unauthenticated = (async () => new Response(null, { status: 401 })) as typeof fetch;

    expect(
      await submitLogout({ fetchImpl: unauthenticated, cookieSource: "bf_csrf=csrf-current" }),
    ).toEqual({ ok: true, revoked: false });
  });

  it("reports CSRF, rejection, and network failures without claiming success", async () => {
    const forbidden = (async () => new Response(null, { status: 403 })) as typeof fetch;
    const rejected = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const cookies = "bf_csrf=csrf-current";

    expect(await submitLogout({ fetchImpl: forbidden, cookieSource: cookies })).toEqual({
      ok: false,
      reason: "csrf",
    });
    expect(await submitLogout({ fetchImpl: rejected, cookieSource: cookies })).toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(await submitLogout({ fetchImpl: offline, cookieSource: cookies })).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("maps outcomes to navigation and distinct failure messages", () => {
    expect(logoutOutcome({ ok: true, revoked: true })).toEqual({
      navigate: true,
      revoked: true,
    });
    expect(logoutOutcome({ ok: true, revoked: false })).toEqual({
      navigate: true,
      revoked: false,
    });
    expect(logoutOutcome({ ok: false, reason: "missing-csrf" })).toEqual({
      navigate: false,
      message: "Session verification token is missing. Refresh the page and try again.",
    });
    expect(logoutOutcome({ ok: false, reason: "csrf" })).toEqual({
      navigate: false,
      message: "Security verification failed. Refresh the page and try again.",
    });
    expect(logoutOutcome({ ok: false, reason: "rejected" })).toEqual({
      navigate: false,
      message: "Sign out failed. Try again.",
    });
    expect(logoutOutcome({ ok: false, reason: "network" })).toEqual({
      navigate: false,
      message: "Logout could not be confirmed because the request failed. Try again.",
    });
  });

  it("reads only the CSRF cookie value", () => {
    expect(readCsrfToken("theme=dark; bf_csrf=abc123; bf_session=hidden")).toBe("abc123");
    expect(readCsrfToken("theme=dark")).toBeNull();
  });

  it("sanitizes display names and falls back safely", () => {
    expect(accountLabel("  Tester  ")).toBe("Tester");
    expect(accountLabel("Bad\u0000Name")).toBe("BadName");
    expect(accountLabel("")).toBe("Your account");
    expect(accountLabel(null)).toBe("Your account");
  });
});
