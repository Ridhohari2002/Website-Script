import { z } from "zod";

/**
 * Typed environment loader. Parsing is lazy and cached so that `next build`
 * does not require runtime secrets, while the first request fails fast with a
 * readable message when a required value is missing.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => value === true || value === "true" || value === "1");

/** Empty placeholders in `.env.local` mean "not configured", not "set to empty". */
const optionalValue = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required at runtime")
      .refine(
        (value) => /^postgres(ql)?:\/\//.test(value),
        "DATABASE_URL must be a postgres:// URL",
      )
      .optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    RATE_LIMIT_HMAC_SECRET: z.string().min(16).optional(),
    RATE_LIMIT_HMAC_KEY_VERSION: z.string().min(1).default("v1"),
    MIDTRANS_SERVER_KEY: z.string().optional(),
    MIDTRANS_CLIENT_KEY: z.string().optional(),
    MIDTRANS_IS_PRODUCTION: booleanish.default(false),
    APP_URL: z.string().default("http://localhost:3000"),
    // Discord OAuth. Optional at boot so `next build` never needs credentials;
    // the login route fails fast with a clear error when they are missing.
    DISCORD_CLIENT_ID: optionalValue,
    DISCORD_CLIENT_SECRET: optionalValue,
    DISCORD_REDIRECT_URI: optionalValue,
    // Primary owner. Optional so local builds and tests need no owner. When set,
    // it must be a Discord snowflake and is compared only against the verified
    // `users.discord_id` of a session; it is never accepted from a client.
    DISCORD_OWNER_ID: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z
        .string()
        .trim()
        .regex(/^\d{17,20}$/, "DISCORD_OWNER_ID must be a Discord snowflake")
        .optional(),
    ),
    // Dedicated server key for hashing session tokens and OAuth state. Required
    // in production; a development-only default is used otherwise.
    SESSION_HMAC_SECRET: z.string().min(16).optional(),
    // Dedicated key material for license-key and executor-token hashing. When
    // absent, version 1 hashes continue to use SESSION_HMAC_SECRET so existing
    // keys keep validating; when present, new material is hashed as version 2.
    KEY_HMAC_SECRET: z.string().min(16).optional(),
    KEY_HMAC_KEY_VERSION: z.enum(["v1", "v2"]).default("v2"),
    // D5 (owner-approved v1): server-only key for HMAC-SHA-256 of normalized
    // HWIDs. Required in production; a development-only default is used otherwise.
    HWID_HASH_SECRET: z.string().min(16).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.RATE_LIMIT_HMAC_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_HMAC_SECRET"],
        message: "RATE_LIMIT_HMAC_SECRET is required in production",
      });
    }
    // A missing dedicated key secret must never silently create version 1
    // hashes from the session secret in production. Existing version 1 keys are
    // still verified with SESSION_HMAC_SECRET once the new secret is set.
    if (value.NODE_ENV === "production" && !value.KEY_HMAC_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["KEY_HMAC_SECRET"],
        message: "KEY_HMAC_SECRET is required in production",
      });
    }
    if (value.KEY_HMAC_SECRET && value.KEY_HMAC_KEY_VERSION !== "v2") {
      ctx.addIssue({
        code: "custom",
        path: ["KEY_HMAC_KEY_VERSION"],
        message: "KEY_HMAC_KEY_VERSION must be v2 when KEY_HMAC_SECRET is set",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function getDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const env = loadEnv(source);
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and configure it.");
  }
  return env.DATABASE_URL;
}

/**
 * Dev-only default keeps unit tests and local builds runnable without a secret.
 * Production refuses to start without an explicit secret (see superRefine).
 */
export function getRateLimitSecret(source: NodeJS.ProcessEnv = process.env): string {
  const env = loadEnv(source);
  if (env.RATE_LIMIT_HMAC_SECRET) return env.RATE_LIMIT_HMAC_SECRET;
  return "development-only-rate-limit-secret-change-me";
}

/**
 * Returns the configured primary owner, or null when ownership is not set.
 * An empty value means "not configured" rather than an invalid id.
 */
export function getDiscordOwnerId(source: NodeJS.ProcessEnv = process.env): string | null {
  return loadEnv(source).DISCORD_OWNER_ID ?? null;
}

export function isProduction(source: NodeJS.ProcessEnv = process.env): boolean {
  return loadEnv(source).NODE_ENV === "production";
}

/**
 * Server-only key for session token and OAuth state hashing. Production must
 * supply its own; development falls back to a clearly labelled default so the
 * test suite and local runs need no secret.
 */
export function getSessionSecret(source: NodeJS.ProcessEnv = process.env): string {
  const env = loadEnv(source);
  if (env.SESSION_HMAC_SECRET) return env.SESSION_HMAC_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("SESSION_HMAC_SECRET is required in production");
  }
  return "development-only-session-secret-change-me";
}

/**
 * Key-hashing material plus the version new hashes are written with.
 *
 * Version 2 uses the dedicated `KEY_HMAC_SECRET`; production refuses to load
 * without it (see `superRefine`), so a deployment can never silently create new
 * version 1 hashes from `SESSION_HMAC_SECRET`. Non-production keeps a version 1
 * fallback so the test suite and local runs need no secret.
 *
 * This function is for writes. Reads must also verify legacy version 1 hashes
 * through `getConfiguredKeySecret` plus `SESSION_HMAC_SECRET`; see the key and
 * executor services.
 */
export function getKeySecretState(source: NodeJS.ProcessEnv = process.env): {
  secret: string;
  version: "v1" | "v2";
} {
  const configured = getConfiguredKeySecret(source);
  if (configured) return configured;
  return { secret: getSessionSecret(source), version: "v1" };
}

/**
 * Dedicated key secret, or null when the deployment has not opted in.
 *
 * `KEY_HMAC_KEY_VERSION` is validated here as well as in the env schema so a
 * caller that bypasses `loadEnv` caching still gets a clear, secret-free error.
 */
export function getConfiguredKeySecret(
  source: NodeJS.ProcessEnv = process.env,
): { secret: string; version: "v2" } | null {
  const env = loadEnv(source);
  if (!env.KEY_HMAC_SECRET) return null;
  if (env.KEY_HMAC_KEY_VERSION !== "v2") {
    throw new Error("KEY_HMAC_KEY_VERSION must be v2 when KEY_HMAC_SECRET is configured");
  }
  return { secret: env.KEY_HMAC_SECRET, version: "v2" };
}

/**
 * Server-only key for HWID HMAC-SHA-256 (D5 v1). Production must supply its
 * own; development falls back to a clearly labelled default so local runs and
 * the test suite need no secret.
 */
export function getHwidSecret(source: NodeJS.ProcessEnv = process.env): string {
  const env = loadEnv(source);
  if (env.HWID_HASH_SECRET) return env.HWID_HASH_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("HWID_HASH_SECRET is required in production");
  }
  return "development-only-hwid-secret-change-me";
}

/** Cookies carry `Secure` on HTTPS origins and in production, never on http://localhost. */
export function secureCookiesEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  const env = loadEnv(source);
  if (env.NODE_ENV === "production") return true;
  try {
    return new URL(env.APP_URL).protocol === "https:";
  } catch {
    return false;
  }
}

/** Test helper. Not used by application code. */
export function resetEnvCache(): void {
  cached = null;
}
