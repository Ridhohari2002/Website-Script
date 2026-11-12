import { REQUEST_ID_HEADER } from "@/core/request-id";

export interface JsonOptions {
  status?: number;
  requestId: string;
  headers?: Record<string, string>;
  /** `Set-Cookie` lines. Kept separate so multiple cookies survive. */
  cookies?: readonly string[];
}

/** Normalized JSON response. Every route returns this shape. */
export function jsonResponse(body: unknown, options: JsonOptions): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set(REQUEST_ID_HEADER, options.requestId);
  for (const cookie of options.cookies ?? []) headers.append("set-cookie", cookie);

  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

export function ok(body: unknown, requestId: string): Response {
  return jsonResponse(body, { status: 200, requestId });
}

/**
 * True when the response carries a `Set-Cookie` that clears `name`. The
 * pipeline uses this so a rotation cookie can never be appended after a handler
 * has deleted the session cookie.
 */
export function responseClearsCookie(response: Response, name: string): boolean {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0]?.trim() ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator) !== name) continue;
    if (pair.slice(separator + 1) === "") return true;
    if (/;\s*max-age=0(?:;|$)/i.test(line)) return true;
  }
  return false;
}

/**
 * Browser redirect helper. Built directly instead of `Response.redirect` so the
 * headers stay mutable for `Set-Cookie` and the response is never cached.
 */
export function redirectResponse(
  location: string,
  cookies: readonly string[] = [],
  status = 302,
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status, headers });
}
