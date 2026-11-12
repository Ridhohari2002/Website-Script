import type { DbExecutor } from "@/db/client";
import type { DiscordProfile } from "@/providers/discord/client";

export interface UserRecord {
  id: string;
  discord_id: string;
  username: string | null;
  avatar_url: string | null;
  status: string;
}

const DISCORD_ID = /^\d{17,20}$/;
const AVATAR_HASH = /^(?:a_)?[0-9a-f]{32}$/i;

/**
 * Display name comes from the profile the server fetched. Control characters
 * are stripped and the value is bounded; nothing here accepts a client claim.
 */
export function resolveDisplayName(profile: DiscordProfile): string {
  const raw = (profile.globalName?.trim() || profile.username.trim() || "Discord user").normalize(
    "NFC",
  );
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "Discord user").slice(0, 100);
}

/** Server-built avatar URL. An unexpected hash is ignored rather than passed through. */
export function resolveAvatarUrl(profile: DiscordProfile): string | null {
  if (!profile.avatar || !AVATAR_HASH.test(profile.avatar)) return null;
  const animated = profile.avatar.startsWith("a_");
  const extension = animated ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${extension}?size=128`;
}

/**
 * Upserts by the immutable Discord user ID. Username and avatar are display
 * data and may change; the identity anchor never does.
 */
export async function upsertUserByDiscordId(
  db: DbExecutor,
  profile: DiscordProfile,
  now: Date,
): Promise<UserRecord> {
  const result = await db.query<UserRecord>(
    `insert into users (discord_id, username, avatar_url, updated_at)
     values ($1, $2, $3, $4)
     on conflict (discord_id) do update
       set username = excluded.username,
           avatar_url = excluded.avatar_url,
           updated_at = excluded.updated_at
     returning id, discord_id, username, avatar_url, status`,
    [profile.id, resolveDisplayName(profile), resolveAvatarUrl(profile), now.toISOString()],
  );
  return result.rows[0]!;
}

/** Every authenticated account carries an explicit `user` role row. */
export async function ensureDefaultRole(
  db: DbExecutor,
  input: { userId: string; now: Date },
): Promise<void> {
  await db.query(
    `insert into user_roles (user_id, role, created_at)
     values ($1, 'user', $2)
     on conflict (user_id, role) do nothing`,
    [input.userId, input.now.toISOString()],
  );
}

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && DISCORD_ID.test(value);
}
