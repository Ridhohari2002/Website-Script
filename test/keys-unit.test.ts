import { describe, expect, it } from "vitest";
import {
  createPlaintextKey,
  hashKeySessionToken,
  hashKeyValue,
  keyDisplayPrefix,
} from "@/modules/keys/crypto";
import { terminalStatusDenial } from "@/modules/keys/service";

describe("key material", () => {
  it("creates high-entropy, prefixed values", () => {
    const keys = new Set(Array.from({ length: 500 }, () => createPlaintextKey()));
    expect(keys.size).toBe(500);
    for (const key of keys) {
      expect(key).toMatch(/^bf_[0-9a-f]{64}$/);
    }
  });

  it("exposes only a short display prefix", () => {
    const key = createPlaintextKey();
    const prefix = keyDisplayPrefix(key);
    expect(prefix).toBe(key.slice(0, 11));
    expect(prefix.length).toBeLessThan(16);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it("hashes keys and session tokens with separate domains", () => {
    const secret = "test-secret-0123456789";
    const key = createPlaintextKey();
    const keyHash = hashKeyValue(key, secret);
    const sessionHash = hashKeySessionToken(key, secret);

    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).not.toContain(key);
    expect(keyHash).not.toBe(sessionHash);
    expect(hashKeyValue(key, secret)).toBe(keyHash);
  });
});

describe("terminal key status precedence", () => {
  it("rejects banned first, then revoked, then suspended", () => {
    expect(terminalStatusDenial("banned")).toBe("banned_key");
    expect(terminalStatusDenial("revoked")).toBe("revoked_key");
    expect(terminalStatusDenial("suspended")).toBe("suspended_key");
  });

  it("does not treat a merely inactive or unused key as terminal", () => {
    expect(terminalStatusDenial("expired")).toBeNull();
    expect(terminalStatusDenial("unused")).toBeNull();
    expect(terminalStatusDenial("active")).toBeNull();
  });
});
