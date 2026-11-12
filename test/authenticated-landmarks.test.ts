import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  redirect: (location: string) => {
    throw new Error(`unexpected redirect: ${location}`);
  },
}));

vi.mock("@/modules/auth/page-session.server", () => ({
  getPageSession: async () => ({
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
  }),
}));

import AuthenticatedLayout from "../app/(authenticated)/layout";
import AuthenticatedError from "../app/(authenticated)/error";

function mainCount(html: string): number {
  return (html.match(/<main\b/g) ?? []).length;
}

describe("authenticated landmark structure", () => {
  it("renders one main landmark and keeps the skip-link target", async () => {
    const element = await AuthenticatedLayout({
      children: createElement("p", null, "Account content"),
    });
    const html = renderToStaticMarkup(element);

    expect(mainCount(html)).toBe(1);
    expect(html).toContain('id="main"');
    expect(html).toContain('href="#main"');
    expect(html).toContain("Account content");
  });

  it("renders the error fallback without a nested main landmark", () => {
    const html = renderToStaticMarkup(
      createElement(AuthenticatedError, {
        error: new Error("session check failed"),
        reset: () => undefined,
      }),
    );

    expect(mainCount(html)).toBe(0);
  });

  it("keeps the error fallback labelled and actionable", () => {
    const html = renderToStaticMarkup(
      createElement(AuthenticatedError, {
        error: new Error("session check failed"),
        reset: () => undefined,
      }),
    );

    expect(html).toContain('aria-labelledby="authenticated-error-title"');
    expect(html).toContain('id="authenticated-error-title"');
    expect(html).toContain("The account page could not be loaded");
    expect(html).toContain("Try again");
    expect(html).toContain('href="/"');
  });
});
