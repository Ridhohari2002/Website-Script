import { describe, expect, it } from "vitest";
import {
  HWID_NORMALIZATION_VERSION,
  HwidNormalizationError,
  hashHwid,
  hwidFingerprint,
  normalizeHwid,
} from "@/core/crypto/hwid";

describe("HWID normalization v1", () => {
  it("is versioned and documented", () => {
    expect(HWID_NORMALIZATION_VERSION).toBe("v1");
  });

  it("folds cosmetic differences to one canonical value", () => {
    const variants = [
      "  AB-CD-EF-12-34-56  ",
      "ab_cd_ef_12_34_56",
      "ab.cd.ef.12.34.56",
      "AB:CD:EF:12:34:56",
      "ab cd ef 12 34 56",
    ];
    for (const value of variants) {
      expect(normalizeHwid(value)).toBe("abcdef123456");
    }
  });

  it("applies NFKC before folding", () => {
    expect(normalizeHwid("ＡＢＣＤ１２３４")).toBe("abcd1234");
  });

  it("rejects values shorter than 8 characters after normalization", () => {
    expect(() => normalizeHwid("ab-cd")).toThrow(HwidNormalizationError);
  });

  it("rejects values longer than 128 characters after normalization", () => {
    expect(() => normalizeHwid("a".repeat(129))).toThrow(HwidNormalizationError);
  });

  it("rejects characters that are not part of the canonical alphabet", () => {
    expect(() => normalizeHwid("abcd!@#$%^&*")).toThrow(HwidNormalizationError);
  });

  it("hashes deterministically with the server secret and domain separation", () => {
    const secret = "test-secret-0123456789";
    const first = hashHwid("AB-CD-EF-12-34-56", secret);
    const second = hashHwid("abcdef123456", secret);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(hashHwid("abcdef123456", "different-secret-0123456789"));
  });

  it("never returns the normalized value from the fingerprint helper", () => {
    const normalized = "abcdef123456";
    const hash = hashHwid(normalized, "test-secret-0123456789");
    const fingerprint = hwidFingerprint(hash);
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).not.toContain(normalized);
  });
});
