import { loadEnv } from "@/core/env";
import { AuthError } from "@/modules/auth/errors";

export interface DiscordOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appUrl: string;
}

/**
 * Discord application configuration for the authorization code flow.
 *
 * Values come from the environment only. The redirect URI must be exactly the
 * app's callback URL: a mismatch with the Discord developer portal is the most
 * common local OAuth failure, and an unconstrained URI would weaken the
 * redirect boundary.
 */
export function loadDiscordConfig(source: NodeJS.ProcessEnv = process.env): DiscordOAuthConfig {
  const env = loadEnv(source);
  const missing = [
    ["DISCORD_CLIENT_ID", env.DISCORD_CLIENT_ID],
    ["DISCORD_CLIENT_SECRET", env.DISCORD_CLIENT_SECRET],
    ["DISCORD_REDIRECT_URI", env.DISCORD_REDIRECT_URI],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new AuthError(
      "not_configured",
      `Discord OAuth is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  const clientId = env.DISCORD_CLIENT_ID!;
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new AuthError("not_configured", "DISCORD_CLIENT_ID is not a Discord application id");
  }

  const expectedRedirect = `${env.APP_URL.replace(/\/+$/, "")}/api/auth/callback`;
  if (env.DISCORD_REDIRECT_URI !== expectedRedirect) {
    throw new AuthError(
      "not_configured",
      `DISCORD_REDIRECT_URI must be exactly ${expectedRedirect}`,
    );
  }

  return {
    clientId,
    clientSecret: env.DISCORD_CLIENT_SECRET!,
    redirectUri: env.DISCORD_REDIRECT_URI!,
    appUrl: env.APP_URL,
  };
}
