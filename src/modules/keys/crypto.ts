import { randomBytes } from "node:crypto";
import { hmacHex } from "@/db/hashing";

/**
 * Key material lives only in this module. Activation plaintext keys are 256-bit
 * random values; the database stores a keyed hash and a short display prefix.
 *
 * Two hash versions exist. Version 1 is the Phase 4 format keyed by
 * `SESSION_HMAC_SECRET`; version 2 is keyed by the dedicated `KEY_HMAC_SECRET`.
 * The domain prefix includes the version so the two schemes can never collide.
 * Reads accept both versions; writes use whichever the deployment configures.
 */

export type KeyHashVersion = "v1" | "v2";

const KEY_PREFIX = "bf_";
const KEY_BYTES = 32;

export function createPlaintextKey(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
}

/** Stored display value, for example `bf_1a2b3c4d`. Non-secret. */
export function keyDisplayPrefix(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX.length + 8);
}

export function hashKeyValue(
  plaintext: string,
  secret: string,
  version: KeyHashVersion = "v1",
): string {
  return hmacHex(secret, `key:${version}:${plaintext}`);
}

export function hashKeySessionToken(
  token: string,
  secret: string,
  version: KeyHashVersion = "v1",
): string {
  return hmacHex(secret, `key_session:${version}:${token}`);
}

/** Executor session tokens are distinct from web key-session tokens. */
export function hashExecutorSessionToken(
  token: string,
  secret: string,
  version: KeyHashVersion = "v2",
): string {
  return hmacHex(secret, `executor_session:${version}:${token}`);
}

/**
 * Nonce hashes are scoped to the session so the same random nonce used by two
 * sessions cannot collide, while a replay inside one session always matches.
 */
export function hashExecutorNonce(nonce: string, secret: string, sessionId: string): string {
  return hmacHex(secret, `executor_nonce:v1:${sessionId}:${nonce}`);
}
