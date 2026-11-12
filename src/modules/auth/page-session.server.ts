import { cookies } from "next/headers";
import { cache } from "react";

import { getDiscordOwnerId, getSessionSecret } from "@/core/env";
import { getSqlDb } from "@/db/client";
import { SESSION_COOKIE } from "@/modules/auth/config";
import { readPageSession } from "@/modules/auth/page-session";

/**
 * Server-only entry point for authenticated page rendering.
 *
 * `cookies()` makes the calling route dynamic, and React `cache` deduplicates
 * the lookup between a protected layout and its page within one request. No
 * session state is written here.
 */
export const getPageSession = cache(async () => {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value ?? null;
  if (!sessionToken) return null;

  return readPageSession(cookieStore, {
    db: getSqlDb(),
    sessionSecret: getSessionSecret(),
    now: new Date(),
    ownerDiscordId: getDiscordOwnerId(),
  });
});
