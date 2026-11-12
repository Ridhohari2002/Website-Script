/**
 * Post-login redirect allowlist. Only same-origin absolute paths are accepted;
 * protocol-relative, backslash, and control-character forms are rejected so the
 * callback cannot become an open redirect.
 */
export function safeRedirectPath(input: string | null | undefined): string {
  if (!input) return "/";
  if (input.length > 512) return "/";
  if (!input.startsWith("/") || input.startsWith("//")) return "/";
  if (input.includes("\\") || /[\u0000-\u001f\u007f]/.test(input)) return "/";
  return input;
}

export function absoluteRedirect(appUrl: string, path: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}${safeRedirectPath(path)}`;
}
