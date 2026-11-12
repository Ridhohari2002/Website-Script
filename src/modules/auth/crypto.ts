import { createHash, randomBytes } from "node:crypto";
import { hmacHex } from "@/db/hashing";

/**
 * Credential primitives for Phase 2. Only these functions create or derive
 * session tokens, OAuth state, and PKCE values.
 */

/** 256-bit CSPRNG value, base64url encoded (43 characters, cookie-safe). */
export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * PKCE code verifier, RFC 7636 section 4.1: 43 characters drawn from
 * `[A-Za-z0-9-._~]`. 32 random bytes encoded as base64url satisfies that.
 */
export function createCodeVerifier(): string {
  return createOpaqueToken();
}

/** PKCE S256 challenge: base64url(sha256(verifier)) without padding. */
export function createCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Session tokens are stored only as a keyed hash. A database read therefore
 * yields no usable credential, and the hash cannot be recomputed without the
 * server key.
 */
export function hashSessionToken(token: string, secret: string): string {
  return hmacHex(secret, `session:v1:${token}`);
}

/** CSRF token bound to one session token hash. Not a standalone credential. */
export function deriveCsrfToken(tokenHash: string, secret: string): string {
  return hmacHex(secret, `csrf:v1:${tokenHash}`);
}

/** OAuth state is stored as a keyed hash, never in plaintext. */
export function hashOAuthState(state: string, secret: string): string {
  return hmacHex(secret, `oauth_state:v1:${state}`);
}
