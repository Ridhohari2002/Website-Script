import { z } from "zod";

/**
 * Executor API request schemas. The executor is untrusted, so every field is
 * bounded and only `key`, `hwid`, `scriptId`, `timestamp`, and `nonce` carry any
 * security meaning. Roblox and executor metadata is stored as telemetry.
 */

const key = z.string().min(1).max(256);
const hwid = z.string().min(1).max(512);
const scriptId = z.string().min(1).max(128);
const clientVersion = z.string().trim().max(64);
const robloxUserId = z.string().trim().max(32);
const robloxUsername = z.string().trim().max(64);
const executorName = z.string().trim().max(64);
const executorVersion = z.string().trim().max(64);

export const executorActivateSchema = z
  .object({
    key,
    hwid,
    scriptId,
    clientVersion: clientVersion.optional(),
    robloxUserId: robloxUserId.optional(),
    robloxUsername: robloxUsername.optional(),
    executorName: executorName.optional(),
    executorVersion: executorVersion.optional(),
  })
  .strict();

/** ISO-8601 string or Unix epoch milliseconds, both bounded to a sane range. */
const timestamp = z.union([
  z.string().datetime({ offset: true }),
  z.string().datetime(),
  z.number().int().nonnegative().max(9_999_999_999_999),
]);

export const executorValidateSchema = z
  .object({
    scriptId,
    hwid,
    timestamp,
    nonce: z.string().min(8).max(200),
    clientVersion: clientVersion.optional(),
  })
  .strict();

export const executorRevokeSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type ExecutorActivateBody = z.infer<typeof executorActivateSchema>;
export type ExecutorValidateBody = z.infer<typeof executorValidateSchema>;
export type ExecutorRevokeBody = z.infer<typeof executorRevokeSchema>;
