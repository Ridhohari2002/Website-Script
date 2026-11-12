import { afterEach, describe, expect, it } from "vitest";
import { getSessionSecret, resetEnvCache, secureCookiesEnabled } from "@/core/env";
import { AuthError } from "@/modules/auth/errors";
import { loadDiscordConfig } from "@/providers/discord/config";

const base = {
  NODE_ENV: "development",
  APP_URL: "http://localhost:3000",
  DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "local-placeholder-secret",
  DISCORD_REDIRECT_URI: "http://localhost:3000/api/auth/callback",
} as unknown as NodeJS.ProcessEnv;

/** The rest of the production env, so only the secret under test is missing. */
const production = {
  ...base,
  NODE_ENV: "production",
  RATE_LIMIT_HMAC_SECRET: "test-rate-limit-secret-0123456789",
} as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  resetEnvCache();
});

function configError(source: NodeJS.ProcessEnv): AuthError {
  try {
    loadDiscordConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error("expected configuration to fail");
}

describe("Discord OAuth configuration", () => {
  it("returns the configured values", () => {
    const config = loadDiscordConfig(base);
    expect(config.clientId).toBe("123456789012345678");
    expect(config.redirectUri).toBe("http://localhost:3000/api/auth/callback");
    expect(config.appUrl).toBe("http://localhost:3000");
  });

  it("fails closed when credentials are missing, without echoing values", () => {
    resetEnvCache();
    const error = configError({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv);
    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("DISCORD_CLIENT_ID");
    expect(error.message).toContain("DISCORD_CLIENT_SECRET");
    expect(error.message).toContain("DISCORD_REDIRECT_URI");
  });

  it("treats empty placeholders as missing", () => {
    resetEnvCache();
    const error = configError({
      ...base,
      DISCORD_CLIENT_SECRET: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(error.code).toBe("not_configured");
  });

  it("rejects a client id that is not a Discord snowflake", () => {
    resetEnvCache();
    const error = configError({
      ...base,
      DISCORD_CLIENT_ID: "not-a-snowflake",
    } as unknown as NodeJS.ProcessEnv);
    expect(error.code).toBe("not_configured");
  });

  it("requires the redirect URI to be exactly the app callback", () => {
    resetEnvCache();
    const error = configError({
      ...base,
      DISCORD_REDIRECT_URI: "http://localhost:3000/api/auth/other",
    } as unknown as NodeJS.ProcessEnv);
    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("DISCORD_REDIRECT_URI");
  });

  it("rejects a redirect URI from another origin", () => {
    resetEnvCache();
    const error = configError({
      ...base,
      DISCORD_REDIRECT_URI: "https://evil.example/api/auth/callback",
    } as unknown as NodeJS.ProcessEnv);
    expect(error.code).toBe("not_configured");
  });
});

describe("session secret and cookie security", () => {
  it("uses a clearly labelled development default outside production", () => {
    resetEnvCache();
    expect(getSessionSecret({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toMatch(
      /development-only/,
    );
  });

  it("requires an explicit session secret in production", () => {
    resetEnvCache();
    expect(() => getSessionSecret(production)).toThrow(/SESSION_HMAC_SECRET is required/);
  });

  it("sets Secure cookies on https origins and in production", () => {
    resetEnvCache();
    expect(secureCookiesEnabled(base)).toBe(false);
    resetEnvCache();
    expect(
      secureCookiesEnabled({
        NODE_ENV: "development",
        APP_URL: "https://hub.example",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    resetEnvCache();
    expect(secureCookiesEnabled(production)).toBe(true);
  });
});
