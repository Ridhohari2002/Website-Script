import { describe, expect, it } from "vitest";
import { bucketIdentifier } from "@/db/rate-limit-store";

describe("rate-limit bucket identifiers", () => {
  it("is deterministic for the same input", () => {
    expect(bucketIdentifier("ip", "203.0.113.7", "secret", "v1")).toBe(
      bucketIdentifier("ip", "203.0.113.7", "secret", "v1"),
    );
  });

  it("does not contain the raw identifier", () => {
    const identifier = bucketIdentifier("user", "discord-12345", "secret", "v1");
    expect(identifier).not.toContain("discord-12345");
    expect(identifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates kinds, versions, and secrets", () => {
    const base = bucketIdentifier("ip", "1.1.1.1", "secret", "v1");
    expect(bucketIdentifier("user", "1.1.1.1", "secret", "v1")).not.toBe(base);
    expect(bucketIdentifier("ip", "1.1.1.1", "secret", "v2")).not.toBe(base);
    expect(bucketIdentifier("ip", "1.1.1.1", "other", "v1")).not.toBe(base);
  });
});
