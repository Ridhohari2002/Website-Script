import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  constantTimeEqualHex,
  hmacHex,
  keyHash,
  requestHash,
  sha256Hex,
} from "@/db/hashing";

describe("hashing helpers", () => {
  it("canonicalizes object key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });

  it("hashes equivalent payloads identically", () => {
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
  });

  it("hashes different payloads differently", () => {
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });

  it("produces a 64-character sha-256 hex digest", () => {
    expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keys the idempotency hash with the secret", () => {
    expect(keyHash("key", "secret-a")).not.toBe(keyHash("key", "secret-b"));
  });

  it("compares hex digests in constant time", () => {
    const digest = hmacHex("secret", "value");
    expect(constantTimeEqualHex(digest, digest)).toBe(true);
    expect(constantTimeEqualHex(digest, hmacHex("secret", "other"))).toBe(false);
    expect(constantTimeEqualHex("zz", "zz")).toBe(false);
  });
});
