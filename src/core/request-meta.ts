/**
 * Request-derived metadata used for rate-limit buckets, session records, and
 * audit rows. Both values are bounded and stripped of control characters.
 *
 * `x-forwarded-for` is only meaningful behind a trusted proxy. It is used for
 * coarse rate limiting and audit context, never for authorization.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 45);
  return null;
}

export function userAgent(request: Request): string | null {
  const value = request.headers.get("user-agent");
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
}
