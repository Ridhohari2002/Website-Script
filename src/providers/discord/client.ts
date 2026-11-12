import type { DiscordOAuthConfig } from "@/providers/discord/config";

/**
 * Discord OAuth 2.0 provider adapter.
 *
 * The authorization code and the access token exist only inside this module and
 * the calling service for the duration of one callback. They are never stored,
 * logged, or returned to the browser. Errors carry a status code only, never a
 * provider body.
 */

export interface DiscordProfile {
  id: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
}

export interface DiscordTokenSet {
  accessToken: string;
  tokenType: string | null;
  scope: string | null;
}

export interface DiscordExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface DiscordOAuthClient {
  exchangeCode(input: DiscordExchangeInput): Promise<DiscordTokenSet>;
  fetchProfile(accessToken: string): Promise<DiscordProfile>;
}

export class DiscordProviderError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "DiscordProviderError";
    this.status = status;
  }
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const TOKEN_ENDPOINT = "https://discord.com/api/oauth2/token";
const PROFILE_ENDPOINT = "https://discord.com/api/users/@me";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createDiscordClient(
  config: DiscordOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): DiscordOAuthClient {
  return {
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new DiscordProviderError("Discord token exchange failed", response.status);
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.access_token !== "string") {
        throw new DiscordProviderError("Discord token response was malformed", response.status);
      }

      return {
        accessToken: payload.access_token,
        tokenType: typeof payload.token_type === "string" ? payload.token_type : null,
        scope: typeof payload.scope === "string" ? payload.scope : null,
      };
    },

    async fetchProfile(accessToken) {
      const response = await fetchImpl(PROFILE_ENDPOINT, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new DiscordProviderError("Discord profile fetch failed", response.status);
      }

      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.id !== "string") {
        throw new DiscordProviderError("Discord profile response was malformed", response.status);
      }

      return {
        id: payload.id,
        username: typeof payload.username === "string" ? payload.username : "",
        globalName: typeof payload.global_name === "string" ? payload.global_name : null,
        avatar: typeof payload.avatar === "string" ? payload.avatar : null,
      };
    },
  };
}
