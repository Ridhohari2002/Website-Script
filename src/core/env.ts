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
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.RATE_LIMIT_HMAC_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_HMAC_SECRET"],
        message: "RATE_LIMIT_HMAC_SECRET is required in production",
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
