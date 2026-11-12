import { randomBytes } from "node:crypto";
import { hmacHex } from "@/db/hashing";

/**
 * Key material lives only in this module. Activation plaintext keys are 256-bit
 * random values; the database stores a keyed hash and a short display prefix.
 */

const KEY_PREFIX = "bf_";
const KEY_BYTES = 32;

export function createPlaintextKey(): string {
  return `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("hex")}`;
}

/** Stored display value, for example `bf_1a2b3c4d`. Non-secret. */
export function keyDisplayPrefix(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX.length + 8);
}

export function hashKeyValue(plaintext: string, secret: string): string {
  return hmacHex(secret, `key:v1:${plaintext}`);
}

export function hashKeySessionToken(token: string, secret: string): string {
  return hmacHex(secret, `key_session:v1:${token}`);
}
