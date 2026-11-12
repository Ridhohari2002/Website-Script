import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
  }),
}));

import { getPageSession } from "@/modules/auth/page-session.server";

describe("getPageSession", () => {
  it("returns null without reading the database when bf_session is absent", async () => {
    await expect(getPageSession()).resolves.toBeNull();
  });
});
