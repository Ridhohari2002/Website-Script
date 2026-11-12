import type { PageSession } from "@/modules/auth/page-session";
import { safeRedirectPath } from "@/modules/auth/redirect";

/**
 * Login entry point for protected pages. The destination is reduced to a
 * same-origin path before it becomes the OAuth `next` value, so a crafted
 * `next` can never send the browser to another origin.
 */
export function loginPathFor(next: string): string {
  return `/api/auth/login?next=${encodeURIComponent(safeRedirectPath(next))}`;
}

export type PageSessionGate =
  { status: "allow"; session: PageSession } | { status: "login"; location: string };

/**
 * Server-side gate for authenticated route groups. A missing, expired,
 * revoked, or non-active session produces a login redirect; it never produces
 * an empty but rendered account page.
 */
export function pageSessionGate(session: PageSession | null, next: string): PageSessionGate {
  if (!session) return { status: "login", location: loginPathFor(next) };
  return { status: "allow", session };
}
