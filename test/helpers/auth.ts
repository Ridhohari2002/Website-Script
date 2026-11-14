import { OAUTH_STATE_COOKIE } from "@/modules/auth/config";
import type { Logger } from "@/core/logger";
import { createAuthService, type AuthService } from "@/modules/auth/service";
import type { DiscordOAuthClient, DiscordProfile } from "@/providers/discord/client";
import type { DiscordOAuthConfig } from "@/providers/discord/config";
import { createTestDatabase, type TestDatabase } from "./db";
import { trustedProxyHeaders } from "./proxy";

export const TEST_SESSION_SECRET = "test-session-secret-value-0123456789";

export const TEST_CONFIG: DiscordOAuthConfig = {
  clientId: "123456789012345678",
  clientSecret: "test-client-secret-not-real",
  redirectUri: "http://localhost:3000/api/auth/callback",
  appUrl: "http://localhost:3000",
};

export class FakeClock {
  private current = new Date("2026-01-01T00:00:00.000Z");

  now = (): Date => new Date(this.current);

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export interface MockDiscordOptions {
  profile?: Partial<DiscordProfile>;
  exchangeError?: boolean;
  profileError?: boolean;
  /** When set, the mock rejects a verifier that does not match, like Discord would. */
  expectedVerifier?: string | null;
}

export interface MockDiscord {
  client: DiscordOAuthClient;
  calls: {
    exchange: Array<{ code: string; codeVerifier: string; redirectUri: string }>;
    profile: string[];
  };
  profile: DiscordProfile;
}

export function createMockDiscord(options: MockDiscordOptions = {}): MockDiscord {
  const profile: DiscordProfile = {
    id: "111122223333444455",
    username: "tester",
    globalName: "Tester",
    avatar: null,
    ...options.profile,
  };

  const calls: MockDiscord["calls"] = { exchange: [], profile: [] };

  const client: DiscordOAuthClient = {
    async exchangeCode(input) {
      calls.exchange.push({ ...input });
      if (options.exchangeError) throw new Error("discord is unavailable");
      if (options.expectedVerifier && input.codeVerifier !== options.expectedVerifier) {
        throw new Error("invalid_grant");
      }
      return { accessToken: "mock-discord-access-token", tokenType: "Bearer", scope: "identify" };
    },
    async fetchProfile(accessToken) {
      calls.profile.push(accessToken);
      if (options.profileError) throw new Error("profile is unavailable");
      return { ...profile };
    },
  };

  return { client, calls, profile };
}

export interface AuthHarness extends TestDatabase {
  clock: FakeClock;
  service: AuthService;
  discord: MockDiscord;
  ownerDiscordId: string | null;
}

export async function createAuthHarness(
  options: {
    clock?: FakeClock;
    discord?: MockDiscord;
    config?: DiscordOAuthConfig | null;
    secureCookies?: boolean;
    logger?: Logger;
    ownerDiscordId?: string | null;
  } = {},
): Promise<AuthHarness> {
  const database = await createTestDatabase();
  const clock = options.clock ?? new FakeClock();
  const discord = options.discord ?? createMockDiscord();
  const config = options.config === undefined ? TEST_CONFIG : (options.config ?? undefined);
  const ownerDiscordId = options.ownerDiscordId ?? null;

  const service = createAuthService({
    db: database.db,
    clock: clock.now,
    discord: discord.client,
    ...(config ? { config } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    sessionSecret: TEST_SESSION_SECRET,
    secureCookies: options.secureCookies ?? false,
    ownerDiscordId,
  });

  return { ...database, clock, service, discord, ownerDiscordId };
}

export interface ServiceLoginResult {
  result: Awaited<ReturnType<AuthService["completeLogin"]>>;
  state: string;
  cookies: string[];
}

/** Full login through the service, as the HTTP routes would drive it. */
export async function loginThroughService(
  service: AuthService,
  options: { next?: string | null; code?: string | null; ip?: string | null } = {},
): Promise<ServiceLoginResult> {
  const start = await service.startLogin({ next: options.next ?? "/" });
  const state = cookieValue(start.cookies, OAUTH_STATE_COOKIE);
  if (!state) throw new Error("login did not set a state cookie");

  const code = options.code === undefined ? "test-authorization-code" : options.code;
  const headers: Record<string, string> = {
    cookie: `${OAUTH_STATE_COOKIE}=${state}`,
    "user-agent": "vitest",
  };
  if (options.ip) Object.assign(headers, trustedProxyHeaders(options.ip));

  const request = new Request(
    `http://localhost:3000/api/auth/callback?code=${encodeURIComponent(code ?? "")}&state=${encodeURIComponent(state)}`,
    { headers },
  );

  const result = await service.completeLogin({ request, code, state, oauthError: null });
  return { result, state, cookies: start.cookies };
}

/** Returns the full Set-Cookie line (attributes included) whose name matches. */
export function setCookieFor(setCookies: readonly string[], name: string): string | null {
  for (const line of setCookies) {
    const pair = line.split(";")[0]?.trim();
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator) === name) return line;
  }
  return null;
}

/** Extracts a cookie's `name=value` pair from one Set-Cookie line. */
function cookiePairFor(setCookies: readonly string[], name: string): string | null {
  const line = setCookieFor(setCookies, name);
  if (!line) return null;
  return line.split(";")[0]?.trim() ?? null;
}

export function cookieValue(setCookies: readonly string[], name: string): string | null {
  const pair = cookiePairFor(setCookies, name);
  if (!pair) return null;
  return pair.slice(pair.indexOf("=") + 1);
}

export function cookieHeaderFrom(setCookies: readonly string[], names: readonly string[]): string {
  const pairs: string[] = [];
  for (const name of names) {
    const pair = cookiePairFor(setCookies, name);
    if (pair) pairs.push(pair);
  }
  return pairs.join("; ");
}
