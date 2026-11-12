import { describe, expect, it } from "vitest";
import { effectiveRoles, isConfiguredOwner, OWNER_ROLE } from "@/modules/auth/owner";

const VERIFIED_ID = "123456789012345678";
const OTHER_ID = "111122223333444455";

describe("owner identity derivation", () => {
  it("adds the owner role when the verified Discord id matches", () => {
    expect(effectiveRoles(["user"], VERIFIED_ID, VERIFIED_ID)).toEqual(["user", OWNER_ROLE]);
    expect(isConfiguredOwner(VERIFIED_ID, VERIFIED_ID)).toBe(true);
  });

  it("does not add the owner role for a different Discord id", () => {
    expect(effectiveRoles(["user"], OTHER_ID, VERIFIED_ID)).toEqual(["user"]);
    expect(isConfiguredOwner(OTHER_ID, VERIFIED_ID)).toBe(false);
  });

  it("treats missing or empty configuration as no owner", () => {
    for (const configured of [null, undefined, ""]) {
      expect(effectiveRoles(["user"], VERIFIED_ID, configured)).toEqual(["user"]);
      expect(isConfiguredOwner(VERIFIED_ID, configured)).toBe(false);
    }
  });

  it("treats a missing verified id as no owner", () => {
    expect(effectiveRoles(["user"], null, VERIFIED_ID)).toEqual(["user"]);
    expect(effectiveRoles(["user"], undefined, VERIFIED_ID)).toEqual(["user"]);
  });

  it("keeps existing roles and never duplicates owner", () => {
    expect(effectiveRoles(["user", "moderator"], VERIFIED_ID, VERIFIED_ID)).toEqual([
      "user",
      "moderator",
      OWNER_ROLE,
    ]);
    expect(effectiveRoles(["user", OWNER_ROLE], VERIFIED_ID, VERIFIED_ID)).toEqual([
      "user",
      OWNER_ROLE,
    ]);
  });

  it("does not mutate the supplied role array", () => {
    const roles = ["user"];
    const result = effectiveRoles(roles, VERIFIED_ID, VERIFIED_ID);
    expect(roles).toEqual(["user"]);
    expect(result).not.toBe(roles);
  });
});
