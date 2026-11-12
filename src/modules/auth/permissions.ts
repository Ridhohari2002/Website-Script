/**
 * Static role-to-permission map. Permissions are additive capabilities and are
 * never implied by seniority (BACKEND.md §10.2, §10.3).
 *
 * Only the ban and reactivation capabilities are defined here because they are
 * the first ones implemented. Anything not in this map is denied: `hasPermission`
 * fails closed so an unknown or future permission can never be "admin by default".
 */
export const ADMIN_ROLES = ["admin", "owner"] as const;

export const PERMISSION_ROLES = {
  "key.ban": ADMIN_ROLES,
  "key.ban.review": ADMIN_ROLES,
  "key.ban.read": ADMIN_ROLES,
  "key.ban.reversal.approve": ADMIN_ROLES,
  "key.ban.reversal.reject": ADMIN_ROLES,
  "key.reactivation": ADMIN_ROLES,
} as const satisfies Record<string, readonly string[]>;

export type Permission = keyof typeof PERMISSION_ROLES;

/**
 * The configured primary owner holds every admin capability. This is the one
 * place where that equivalence is defined, so a new admin-only gate cannot
 * accidentally exclude the owner without updating this helper.
 */
export function hasAdminAccess(roles: readonly string[]): boolean {
  return roles.includes("admin") || roles.includes("owner");
}

export function hasPermission(roles: readonly string[], permission: string): boolean {
  const allowed: readonly string[] | undefined = PERMISSION_ROLES[permission as Permission];
  if (!allowed) return false;
  return roles.some((role) => allowed.includes(role));
}
