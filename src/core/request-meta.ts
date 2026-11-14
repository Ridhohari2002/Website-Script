import { isIP } from "node:net";
import { getTrustedProxySecret } from "@/core/env";
import { constantTimeEqualHex, sha256Hex } from "@/db/hashing";

/**
 * Request-derived metadata used for rate-limit buckets, session records, and
 * audit rows. Both values are bounded and stripped of control characters.
 *
 * Client IP is only accepted when the request proves it came through the
 * configured reverse proxy. The proxy must remove any client-supplied marker,
 * remove or overwrite `x-forwarded-for`, and inject its own marker header. A
 * request without a valid marker is treated as having no verified IP; it is
 * never inferred from a client-controlled header.
 *
 * `x-real-ip` is deliberately ignored because it has the same spoofing
 * properties as `x-forwarded-for` and is not covered by the marker contract.
 */

export const TRUSTED_PROXY_SECRET_HEADER = "x-boyfinity-proxy-secret";

export interface ClientIpOptions {
  /**
   * Server-only proxy marker. Omit to read `TRUSTED_PROXY_SECRET`; pass `null`
   * in tests to prove the untrusted path without touching process state.
   */
  trustedProxySecret?: string | null;
}

function markerMatches(provided: string, expected: string): boolean {
  // Hash both sides first so the comparison is constant-time and does not leak
  // the secret length through an early return.
  return constantTimeEqualHex(sha256Hex(provided), sha256Hex(expected));
}

function normalizeIp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return isIP(unwrapped) === 0 ? null : unwrapped;
}

export function clientIp(request: Request, options: ClientIpOptions = {}): string | null {
  const secret =
    options.trustedProxySecret === undefined ? getTrustedProxySecret() : options.trustedProxySecret;
  if (!secret) return null;

  const marker = request.headers.get(TRUSTED_PROXY_SECRET_HEADER);
  if (!marker || !markerMatches(marker, secret)) return null;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded === null) return null;

  // The proxy must overwrite (not append to) the header with exactly one
  // address. A comma list is rejected even when the marker is valid, so a
  // client cannot append an address and influence which value is selected.
  const values = forwarded.split(",");
  if (values.length !== 1) return null;
  return normalizeIp(values[0]!);
}

export function userAgent(request: Request): string | null {
  const value = request.headers.get("user-agent");
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
}
