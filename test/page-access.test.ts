import { describe, expect, it } from "vitest";

import { loginPathFor, pageSessionGate } from "@/modules/auth/page-access";
import type { PageSession } from "@/modules/auth/page-session";

const session: PageSession = {
  userId: "user-1",
  sessionId: "session-1",
  user: {
    id: "user-1",
    discordId: "111122223333444455",
    username: "Tester",
    avatarUrl: null,
  },
  roles: ["user"],
  csrfToken: "csrf-token",
  expiresAt: "2026-01-02T00:00:00.000Z",
};

function nextValue(loginPath: string): string | null {
  return new URL(loginPath, "http://localhost:3000").searchParams.get("next");
}

describe("authenticated page gate", () => {
  it("sends an unauthenticated visitor to the existing login entry point", () => {
    const gate = pageSessionGate(null, "/dashboard");

    expect(gate.status).toBe("login");
    if (gate.status !== "login") throw new Error("expected a login redirect");
    expect(gate.location.startsWith("/api/auth/login?")).toBe(true);
    expect(nextValue(gate.location)).toBe("/dashboard");
  });

  it("allows a valid server session", () => {
    const gate = pageSessionGate(session, "/dashboard");

    expect(gate.status).toBe("allow");
    if (gate.status !== "allow") throw new Error("expected an allow decision");
    expect(gate.session).toBe(session);
  });
});

describe("login return path safety", () => {
  it("keeps safe internal paths and query strings", () => {
    expect(nextValue(loginPathFor("/dashboard?tab=keys"))).toBe("/dashboard?tab=keys");
    expect(nextValue(loginPathFor("/dashboard#account"))).toBe("/dashboard#account");
  });

  it("rejects external and ambiguous destinations", () => {
    for (const candidate of [
      "https://evil.example/steal",
      "http://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/dashboard\nSet-Cookie: session=bad",
    ]) {
      expect(nextValue(loginPathFor(candidate))).toBe("/");
    }
  });
});
