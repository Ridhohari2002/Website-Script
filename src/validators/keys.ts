import { z } from "zod";
import { badRequest } from "@/core/errors";

/** Shared request schemas for the Phase 4 key endpoints. */

const boundedKey = z.string().min(1).max(256);
const boundedHwid = z.string().min(1).max(512);
const reason = z.string().trim().max(500);

export const activateSchema = z
  .object({
    key: boundedKey,
    hwid: boundedHwid.optional(),
    deviceLabel: z.string().trim().max(120).optional(),
  })
  .strict();

export const validateSchema = z
  .object({
    key: boundedKey,
    scriptId: z.string().min(1).max(128),
    hwid: boundedHwid.optional(),
  })
  .strict();

export const adminResetHwidSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const adminRevokeSchema = z
  .object({
    reason: reason.optional(),
  })
  .strict();

export const adminGenerateSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(100).default(1),
    type: z.enum(["free", "paid"]).default("paid"),
    expiresAt: z.string().datetime().optional(),
    maxActivations: z.coerce.number().int().min(1).max(100).default(1),
    planId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
  })
  .strict();

export const adminListQuerySchema = z
  .object({
    status: z.enum(["unused", "active", "expired", "revoked", "suspended", "banned"]).optional(),
    type: z.enum(["free", "paid"]).optional(),
    ownerDiscordId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const keyIdSchema = z.string().uuid();

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

/** Required for activation and self-service reset (D10). */
export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw badRequest("A valid Idempotency-Key header is required");
  }
  return value;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header) throw badRequest("Authorization header is required");
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) throw badRequest("Authorization header must be a Bearer token");
  return match[1];
}
