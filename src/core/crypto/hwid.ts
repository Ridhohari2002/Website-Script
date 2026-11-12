import { getHwidSecret } from "@/core/env";
import { hmacHex } from "@/db/hashing";

/**
 * D5 (owner-approved) HWID normalization, version 1.
 *
 * The scheme is deliberately fixed and exported so a future revision can add
 * `v2` without silently changing the meaning of existing `bound_hwid_hash`
 * values. Raw HWIDs never leave this module: callers receive either a keyed
 * hash or a short, non-reversible fingerprint.
 *
 * v1 steps:
 *   1. Unicode NFKC normalization.
 *   2. Trim, then lowercase (case-fold for ASCII; the platform IDs we accept
 *      are ASCII).
 *   3. Remove common cosmetic separators: whitespace, `-`, `_`, `.`, `:`, `/`,
 *      `\`.
 *   4. Require 8–128 characters after normalization.
 */

export const HWID_NORMALIZATION_VERSION = "v1";

const SEPARATORS = /[\s\-_.:/\\]+/g;
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

export class HwidNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HwidNormalizationError";
  }
}

export function normalizeHwid(raw: string): string {
  if (typeof raw !== "string") throw new HwidNormalizationError("HWID must be a string");
  const normalized = raw.normalize("NFKC").trim().toLowerCase().replace(SEPARATORS, "");
  if (normalized.length < MIN_LENGTH) {
    throw new HwidNormalizationError("HWID is too short");
  }
  if (normalized.length > MAX_LENGTH) {
    throw new HwidNormalizationError("HWID is too long");
  }
  if (!/^[a-z0-9]+$/.test(normalized)) {
    // Remaining characters are not separators we know how to fold. Rejecting is
    // safer than storing a binding that differs cosmetically across platforms.
    throw new HwidNormalizationError("HWID contains unsupported characters");
  }
  return normalized;
}

/** HKDF-like domain separation keeps HWID hashes distinct from other HMAC uses. */
export function hashHwid(raw: string, secret: string = getHwidSecret()): string {
  return hmacHex(secret, `hwid:${HWID_NORMALIZATION_VERSION}:${normalizeHwid(raw)}`);
}

/** Short non-reversible display value. Safe for owner/admin read responses. */
export function hwidFingerprint(hash: string): string {
  return hash.slice(0, 12);
}
