export type SameSite = "Lax" | "Strict" | "None";

export interface CookieAttributes {
  secure: boolean;
  maxAgeSeconds?: number;
  path?: string;
  httpOnly?: boolean;
  sameSite?: SameSite;
}

/**
 * Cookie serialization for the two auth cookies. The session cookie is always
 * HttpOnly; the CSRF cookie is readable by first-party JavaScript on purpose,
 * because the client must echo it in the `x-csrf-token` header. The server
 * never trusts the CSRF cookie value itself.
 */
export function serializeCookie(name: string, value: string, attributes: CookieAttributes): string {
  const parts = [`${name}=${value}`, `Path=${attributes.path ?? "/"}`];
  parts.push(`SameSite=${attributes.sameSite ?? "Lax"}`);
  if (attributes.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(attributes.maxAgeSeconds))}`);
  }
  if (attributes.httpOnly ?? true) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(
  name: string,
  attributes: Pick<CookieAttributes, "secure" | "path" | "sameSite" | "httpOnly">,
): string {
  return serializeCookie(name, "", { ...attributes, maxAgeSeconds: 0 });
}

/** Minimal `Cookie` header parser. Malformed pairs are ignored, never thrown. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}

export function readCookie(request: Request, name: string): string | null {
  return parseCookies(request.headers.get("cookie"))[name] ?? null;
}
