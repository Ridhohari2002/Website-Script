import { describe, expect, it } from "vitest";
import {
  createCodeChallenge,
  createCodeVerifier,
  createOpaqueToken,
  deriveCsrfToken,
  hashOAuthState,
  hashSessionToken,
} from "@/modules/auth/crypto";

/**
 * PKCE S256 generation (RFC 7636). Discord enforcement of `code_verifier` is a
 * separate, still-pending sandbox check; these tests prove only that our values
 * and the challenge derivation are correct.
 */
describe("PKCE S256", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(createCodeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a 43-character verifier from the RFC charset", () => {
    for (let index = 0; index < 20; index += 1) {
      const verifier = createCodeVerifier();
      expect(verifier).toHaveLength(43);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
    }
  });

  it("produces a 43-character base64url challenge with no padding", () => {
    const challenge = createCodeChallenge(createCodeVerifier());
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a different challenge for a different verifier", () => {
    expect(createCodeChallenge(createCodeVerifier())).not.toBe(
      createCodeChallenge(createCodeVerifier()),
    );
  });
});

describe("opaque tokens and keyed hashes", () => {
  it("generates 256-bit URL-safe tokens", () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const token = createOpaqueToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it("hashes a session token to 64 hex characters and never to the token itself", () => {
    const token = createOpaqueToken();
    const hash = hashSessionToken(token, "secret-a");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashSessionToken(token, "secret-a")).toBe(hash);
  });

  it("binds the hash to the server secret", () => {
    const token = createOpaqueToken();
    expect(hashSessionToken(token, "secret-a")).not.toBe(hashSessionToken(token, "secret-b"));
  });

  it("derives a different CSRF token per session hash", () => {
    const first = hashSessionToken(createOpaqueToken(), "secret");
    const second = hashSessionToken(createOpaqueToken(), "secret");
    expect(deriveCsrfToken(first, "secret")).not.toBe(deriveCsrfToken(second, "secret"));
  });

  it("hashes OAuth state and changes the hash with the secret", () => {
    const state = createOpaqueToken();
    expect(hashOAuthState(state, "secret-a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOAuthState(state, "secret-a")).not.toBe(hashOAuthState(state, "secret-b"));
  });
});
