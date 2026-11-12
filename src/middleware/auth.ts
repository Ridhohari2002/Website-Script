import { forbidden, unauthorized } from "@/core/errors";
import { hasAdminAccess, hasPermission } from "@/modules/auth/permissions";
import type { SessionContext } from "@/middleware/session";

/**
 * Reusable authorization guards for handlers that need finer control than the
 * route-level `access` declaration.
 *
 * All three read the server-resolved session only. A role, user ID, or
 * permission supplied by the client is never consulted.
 */
export function requireUser(session: SessionContext | null): SessionContext {
  if (!session) throw unauthorized("Authentication required");
  return session;
}

export function requireRole(
  session: SessionContext | null,
  allowedRoles: readonly string[],
): SessionContext {
  const resolved = requireUser(session);
  const directMatch = allowedRoles.some((role) => resolved.roles.includes(role));
  const ownerSatisfiesAdmin = allowedRoles.includes("admin") && hasAdminAccess(resolved.roles);
  if (!directMatch && !ownerSatisfiesAdmin) {
    throw forbidden("Insufficient role");
  }
  return resolved;
}

/** Fails closed: an unknown permission is denied, never granted by seniority. */
export function requirePermission(
  session: SessionContext | null,
  permission: string,
): SessionContext {
  const resolved = requireUser(session);
  if (!hasPermission(resolved.roles, permission)) {
    throw forbidden("Insufficient permission");
  }
  return resolved;
}
