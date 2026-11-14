import { afterEach, describe, expect, it } from "vitest";
import {
  getConfiguredKeySecret,
  getDatabaseUrl,
  getDiscordOwnerId,
  getHwidSecret,
  getKeySecretState,
  getRateLimitSecret,
  getTrustedProxySecret,
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
      KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
      SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
      HWID_HASH_SECRET: "a-sufficiently-long-hwid-secret-value",
      TRUSTED_PROXY_SECRET: "a-sufficiently-long-proxy-secret-value",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("production");
  });

  it("requires KEY_HMAC_SECRET in production", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/KEY_HMAC_SECRET is required in production/);
  });

  it("rejects KEY_HMAC_KEY_VERSION other than v2 when a dedicated secret is set", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        KEY_HMAC_SECRET: "dedicated-key-secret-0123456789",
        KEY_HMAC_KEY_VERSION: "v1",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/KEY_HMAC_KEY_VERSION must be v2/);
  });

  it("exposes no configured key secret when the deployment has not opted in", () => {
    resetEnvCache();
    expect(getConfiguredKeySecret({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    resetEnvCache();
    expect(
      getConfiguredKeySecret({
        KEY_HMAC_SECRET: "dedicated-key-secret-0123456789",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ secret: "dedicated-key-secret-0123456789", version: "v2" });
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

  it("uses a dedicated key secret when configured and falls back to v1 otherwise", () => {
    const configured = getKeySecretState({
      KEY_HMAC_SECRET: "dedicated-key-secret-0123456789",
      SESSION_HMAC_SECRET: "session-secret-0123456789",
    } as unknown as NodeJS.ProcessEnv);
    expect(configured).toEqual({
      secret: "dedicated-key-secret-0123456789",
      version: "v2",
    });

    resetEnvCache();
    const fallback = getKeySecretState({
      SESSION_HMAC_SECRET: "session-secret-0123456789",
    } as unknown as NodeJS.ProcessEnv);
    expect(fallback).toEqual({ secret: "session-secret-0123456789", version: "v1" });
  });

  it("treats an absent or empty trusted proxy secret as not configured outside production", () => {
    expect(getTrustedProxySecret({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      getTrustedProxySecret({ TRUSTED_PROXY_SECRET: "" } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    resetEnvCache();
    expect(
      getTrustedProxySecret({
        TRUSTED_PROXY_SECRET: "test-trusted-proxy-secret-0123456789",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("test-trusted-proxy-secret-0123456789");
  });

  it("requires TRUSTED_PROXY_SECRET in production", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
        KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
        SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
        HWID_HASH_SECRET: "a-sufficiently-long-hwid-secret-value",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/TRUSTED_PROXY_SECRET is required in production/);
  });

  it("rejects an invalid trusted proxy secret in production", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
        KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
        SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
        HWID_HASH_SECRET: "a-sufficiently-long-hwid-secret-value",
        TRUSTED_PROXY_SECRET: "short",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/TRUSTED_PROXY_SECRET/);
  });

  it("accepts a valid trusted proxy secret in production", () => {
    resetEnvCache();
    const secret = "a-sufficiently-long-proxy-secret-value";
    expect(
      getTrustedProxySecret({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
        KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
        SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
        HWID_HASH_SECRET: "a-sufficiently-long-hwid-secret-value",
        TRUSTED_PROXY_SECRET: secret,
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(secret);
  });

  it("runs without a trusted proxy secret in development and test", () => {
    resetEnvCache();
    expect(loadEnv({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv).NODE_ENV).toBe(
      "development",
    );
    resetEnvCache();
    expect(loadEnv({ NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv).NODE_ENV).toBe("test");
  });

  it("does not echo the trusted proxy secret in a validation error", () => {
    resetEnvCache();
    const secret = "leak-check-secret-value";
    let message = "";
    try {
      loadEnv({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
        KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
        SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
        HWID_HASH_SECRET: "a-sufficiently-long-hwid-secret-value",
        TRUSTED_PROXY_SECRET: "short",
      } as unknown as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("TRUSTED_PROXY_SECRET");
    expect(message).not.toContain(secret);
  });

  it("rejects a too-short trusted proxy secret outside production", () => {
    expect(() =>
      loadEnv({ TRUSTED_PROXY_SECRET: "short" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/TRUSTED_PROXY_SECRET/);
  });

  it("uses the development-only HWID secret outside production", () => {
    const secret = getHwidSecret({} as unknown as NodeJS.ProcessEnv);
    expect(secret).toMatch(/development-only/);
  });

  it("requires HWID_HASH_SECRET when used in production", () => {
    resetEnvCache();
    expect(() =>
      getHwidSecret({
        NODE_ENV: "production",
        RATE_LIMIT_HMAC_SECRET: "a-sufficiently-long-secret-value",
        KEY_HMAC_SECRET: "a-sufficiently-long-key-secret-value",
        SESSION_HMAC_SECRET: "a-sufficiently-long-session-secret-value",
        TRUSTED_PROXY_SECRET: "a-sufficiently-long-proxy-secret-value",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/HWID_HASH_SECRET is required in production/);
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
