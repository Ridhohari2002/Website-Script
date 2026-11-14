/**
 * Test-only trusted-proxy configuration.
 *
 * Production has no default proxy secret. The suite opts into a known test
 * secret so requests can exercise the trusted path; tests for the untrusted
 * path pass an explicit `null` secret to `clientIp`.
 */

export const TEST_TRUSTED_PROXY_SECRET = "test-trusted-proxy-secret-0123456789";
export const TEST_TRUSTED_PROXY_HEADER = "x-boyfinity-proxy-secret";

export function trustedProxyHeaders(ip: string): Record<string, string> {
  return {
    "x-forwarded-for": ip,
    [TEST_TRUSTED_PROXY_HEADER]: TEST_TRUSTED_PROXY_SECRET,
  };
}
