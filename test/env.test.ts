import { afterEach, describe, expect, it } from "vitest";
import {
  getDatabaseUrl,
  getDiscordOwnerId,
  getRateLimitSecret,
  loadEnv,
  resetEnvCache,
} from "@/core/env";

afterEach(() => {
  resetEnvCache();
});

describe("environment loader", () => {
  it("applies safe defaults", () => {
    const env = loadEnv({} as unknown as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.MIDTRANS_IS_PRODUCTION).toBe(false);
    expect(env.RATE_LIMIT_HMAC_KEY_VERSION).toBe("v1");
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadEnv({ NODE_ENV: "staging" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("uses the development-only rate-limit secret outside production", () => {
    const secret = getRateLimitSecret({} as unknown as NodeJS.ProcessEnv);
    expect(secret).toMatch(/development-only/);
  });

  it("requires RATE_LIMIT_HMAC_SECRET in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toThrow(
      /RATE_LIMIT_HMAC_SECRET is required in production/,
    );
  });

  it("accepts a compliant production environment", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("production");
  });

  it("requires a postgres URL when one is provided", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "mysql://localhost/db" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/must be a postgres/);
  });

  it("throws a helpful error when DATABASE_URL is absent", () => {
    expect(() => getDatabaseUrl({} as unknown as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  it("parses MIDTRANS_IS_PRODUCTION as a boolean", () => {
    expect(
      loadEnv({ MIDTRANS_IS_PRODUCTION: "false" } as unknown as NodeJS.ProcessEnv)
        .MIDTRANS_IS_PRODUCTION,
    ).toBe(false);
    resetEnvCache();
    expect(
      loadEnv({ MIDTRANS_IS_PRODUCTION: "true" } as unknown as NodeJS.ProcessEnv)
        .MIDTRANS_IS_PRODUCTION,
    ).toBe(true);
  });

  it("parses a valid Discord owner snowflake", () => {
    const source = { DISCORD_OWNER_ID: "123456789012345678" } as unknown as NodeJS.ProcessEnv;
    expect(getDiscordOwnerId(source)).toBe("123456789012345678");
    expect(
      loadEnv({ DISCORD_OWNER_ID: " 123456789012345678 " } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({ DISCORD_OWNER_ID: "123456789012345678" });
  });

  it("treats an absent or empty Discord owner as not configured", () => {
    expect(getDiscordOwnerId({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(getDiscordOwnerId({ DISCORD_OWNER_ID: "" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      getDiscordOwnerId({ DISCORD_OWNER_ID: "   " } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("rejects a malformed Discord owner id", () => {
    for (const value of [
      "not-a-snowflake",
      "123",
      "123456789012345678x",
      "123456789012345678901",
    ]) {
      resetEnvCache();
      expect(() => loadEnv({ DISCORD_OWNER_ID: value } as unknown as NodeJS.ProcessEnv)).toThrow(
        /DISCORD_OWNER_ID must be a Discord snowflake/,
      );
    }
  });
});
