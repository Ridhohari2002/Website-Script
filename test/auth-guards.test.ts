import { describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import { requirePermission, requireRole, requireUser } from "@/middleware/auth";
import { hasPermission, PERMISSION_ROLES } from "@/modules/auth/permissions";
import type { SessionContext } from "@/middleware/session";

const userSession: SessionContext = { userId: "user-1", roles: ["user"] };
const moderatorSession: SessionContext = { userId: "mod-1", roles: ["moderator"] };
const adminSession: SessionContext = { userId: "admin-1", roles: ["admin"] };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected the guard to throw");
}

describe("authorization guards", () => {
  it("rejects a missing session", () => {
    expect(codeOf(() => requireUser(null))).toBe("unauthorized");
    expect(codeOf(() => requireRole(null, ["admin"]))).toBe("unauthorized");
    expect(codeOf(() => requirePermission(null, "key.ban"))).toBe("unauthorized");
  });

  it("accepts a session with an allowed role", () => {
    expect(requireUser(userSession)).toBe(userSession);
    expect(requireRole(adminSession, ["admin"])).toBe(adminSession);
  });

  it("denies a role that is not held", () => {
    expect(codeOf(() => requireRole(userSession, ["admin"]))).toBe("forbidden");
    expect(codeOf(() => requireRole(moderatorSession, ["admin"]))).toBe("forbidden");
  });

  it("resolves the ban permissions from the static map", () => {
    for (const permission of Object.keys(PERMISSION_ROLES)) {
      expect(hasPermission(["admin"], permission)).toBe(true);
      expect(hasPermission(["moderator"], permission)).toBe(false);
      expect(hasPermission(["user"], permission)).toBe(false);
    }
    expect(codeOf(() => requirePermission(userSession, "key.ban"))).toBe("forbidden");
    expect(requirePermission(adminSession, "key.ban")).toBe(adminSession);
  });

  it("fails closed for unknown permissions", () => {
    expect(hasPermission(["admin"], "key.future.permission")).toBe(false);
    expect(hasPermission(["admin"], "")).toBe(false);
    expect(codeOf(() => requirePermission(adminSession, "key.future.permission"))).toBe(
      "forbidden",
    );
  });

  it("grants no ban or reactivation capability to moderator or user", () => {
    for (const permission of Object.keys(PERMISSION_ROLES)) {
      expect(hasPermission(["moderator"], permission)).toBe(false);
      expect(hasPermission(["user", "moderator"], permission)).toBe(false);
    }
  });
});
