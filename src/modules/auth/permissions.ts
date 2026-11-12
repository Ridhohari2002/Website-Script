/**
 * Static role-to-permission map. Permissions are additive capabilities and are
 * never implied by seniority (BACKEND.md §10.2, §10.3).
 *
 * Only the ban and reactivation capabilities are defined here because they are
 * the first ones implemented. Anything not in this map is denied: `hasPermission`
 * fails closed so an unknown or future permission can never be "admin by default".
 */
export const PERMISSION_ROLES = {
  "key.ban": ["admin"],
  "key.ban.review": ["admin"],
  "key.ban.read": ["admin"],
  "key.ban.reversal.approve": ["admin"],
  "key.ban.reversal.reject": ["admin"],
  "key.reactivation": ["admin"],
} as const satisfies Record<string, readonly string[]>;

export type Permission = keyof typeof PERMISSION_ROLES;

export function hasPermission(roles: readonly string[], permission: string): boolean {
  const allowed: readonly string[] | undefined = PERMISSION_ROLES[permission as Permission];
  if (!allowed) return false;
  return roles.some((role) => allowed.includes(role));
}
