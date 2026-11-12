/**
 * Owner identity is server configuration, not persisted state.
 *
 * The Discord id compared here must come from the verified session row's
 * `users.discord_id`. Nothing in this module reads a request header, cookie,
 * query parameter, or body, so a client cannot claim owner status.
 *
 * The role is derived on every request. Removing or changing the configured id
 * takes effect on the next request after the process restarts; no database row
 * has to be cleaned up.
 */

export const OWNER_ROLE = "owner";

export function isConfiguredOwner(
  verifiedDiscordId: string | null | undefined,
  configuredOwnerId: string | null | undefined,
): boolean {
  if (!configuredOwnerId || !verifiedDiscordId) return false;
  return verifiedDiscordId === configuredOwnerId;
}

/** Appends `owner` once when the verified id matches the configured owner. */
export function effectiveRoles(
  databaseRoles: readonly string[] | null | undefined,
  verifiedDiscordId: string | null | undefined,
  configuredOwnerId: string | null | undefined,
): string[] {
  const roles = [...(databaseRoles ?? [])];
  if (isConfiguredOwner(verifiedDiscordId, configuredOwnerId) && !roles.includes(OWNER_ROLE)) {
    roles.push(OWNER_ROLE);
  }
  return roles;
}
