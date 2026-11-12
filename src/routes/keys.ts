import { z } from "zod";
import { clientIp } from "@/core/request-meta";
import { jsonResponse } from "@/core/response";
import { readJsonBody } from "@/middleware/body-limit";
import { validate } from "@/middleware/validation";
import type { RouteDefinition } from "@/http/router";
import type { KeyService } from "@/modules/keys/service";
import {
  activateSchema,
  adminGenerateSchema,
  adminListQuerySchema,
  adminResetHwidSchema,
  adminRevokeSchema,
  bearerToken,
  keyIdSchema,
  resetHwidSchema,
  requireIdempotencyKey,
  validateSchema,
} from "@/validators/keys";

/**
 * Phase 4 key endpoints (BACKEND.md §9.5). Route files only translate HTTP;
 * ownership, status gates, locking, and auditing live in the key service.
 */

const KEY_WINDOW_SECONDS = 60;
const ACTIVATE_USER_LIMIT = 10;
const ACTIVATE_IP_LIMIT = 30;
const VALIDATE_USER_LIMIT = 120;
const VALIDATE_IP_LIMIT = 240;
const RESET_USER_LIMIT = 5;
const RESET_IP_LIMIT = 15;

const idSchema = z.string().uuid();

function userKeyLimit(context: {
  request: Request;
  session: { userId: string } | null;
}): { kind: "user" | "ip"; value: string; limit: number; windowSeconds: number }[] {
  const dimensions: ReturnType<typeof userKeyLimit> = [];
  if (context.session) {
    dimensions.push({
      kind: "user",
      value: context.session.userId,
      limit: ACTIVATE_USER_LIMIT,
      windowSeconds: KEY_WINDOW_SECONDS,
    });
  }
  dimensions.push({
    kind: "ip",
    value: clientIp(context.request) ?? "unknown",
    limit: ACTIVATE_IP_LIMIT,
    windowSeconds: KEY_WINDOW_SECONDS,
  });
  return dimensions;
}

export function keyRoutes(service: KeyService): RouteDefinition[] {
  return [
    {
      method: "POST",
      pattern: ["keys", "activate"],
      access: "user",
      rateLimit: userKeyLimit,
      async handler({ session, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const body = validate(activateSchema, await readJsonBody(request));
        const idempotencyKey = requireIdempotencyKey(request);
        const result = await service.activate({
          session,
          request,
          key: body.key,
          ...(body.hwid ? { hwid: body.hwid } : {}),
          ...(body.deviceLabel ? { deviceLabel: body.deviceLabel } : {}),
          idempotencyKey,
        });
        return jsonResponse(result.body, { status: result.status, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["keys", "validate"],
      access: "user",
      rateLimit: (context) => {
        const dimensions = userKeyLimit(context);
        return dimensions.map((dimension) => ({
          ...dimension,
          limit: dimension.kind === "user" ? VALIDATE_USER_LIMIT : VALIDATE_IP_LIMIT,
        }));
      },
      async handler({ session, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const body = validate(validateSchema, await readJsonBody(request));
        const token = bearerToken(request);
        const result = await service.validate({
          session,
          request,
          key: body.key,
          scriptId: body.scriptId,
          ...(body.hwid ? { hwid: body.hwid } : {}),
          keySessionToken: token,
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["keys", "reset-hwid"],
      access: "user",
      rateLimit: (context) =>
        userKeyLimit(context).map((dimension) => ({
          ...dimension,
          limit: dimension.kind === "user" ? RESET_USER_LIMIT : RESET_IP_LIMIT,
        })),
      async handler({ session, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const body = validate(resetHwidSchema, await readJsonBody(request));
        const idempotencyKey = requireIdempotencyKey(request);
        const result = await service.resetHwid({
          session,
          request,
          keyId: body.keyId,
          ...(body.reason ? { reason: body.reason } : {}),
          idempotencyKey,
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["keys", "me"],
      access: "user",
      async handler({ session, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keys = await service.listOwnKeys(session);
        return jsonResponse({ keys }, { status: 200, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["keys", ":id", "usage"],
      access: "user",
      async handler({ session, params, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(idSchema, params.id);
        const usage = await service.keyUsage(session, keyId);
        return jsonResponse(usage, { status: 200, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["keys", ":id", "devices"],
      access: "user",
      async handler({ session, params, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(idSchema, params.id);
        const devices = await service.keyDevices(session, keyId);
        return jsonResponse({ devices }, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["admin", "keys"],
      access: "admin",
      async handler({ session, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const body = validate(adminGenerateSchema, await readJsonBody(request));
        const keys = await service.generateKeys({
          session,
          request,
          count: body.count,
          type: body.type,
          ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
          maxActivations: body.maxActivations,
          ...(body.planId ? { planId: body.planId } : {}),
        });
        return jsonResponse({ keys }, { status: 201, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["admin", "keys"],
      access: "admin",
      async handler({ session, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const query = Object.fromEntries(new URL(request.url).searchParams.entries());
        const filter = validate(adminListQuerySchema, query);
        const keys = await service.adminListKeys(filter);
        return jsonResponse({ keys }, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["admin", "keys", ":id", "revoke"],
      access: "admin",
      async handler({ session, params, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(keyIdSchema, params.id);
        const body = validate(adminRevokeSchema, await readJsonBody(request));
        const result = await service.adminRevoke({
          session,
          request,
          keyId,
          ...(body.reason ? { reason: body.reason } : {}),
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["admin", "keys", ":id", "reset-hwid"],
      access: "admin",
      async handler({ session, params, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(keyIdSchema, params.id);
        const body = validate(adminResetHwidSchema, await readJsonBody(request));
        const result = await service.adminResetHwid({
          session,
          request,
          keyId,
          reason: body.reason,
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["admin", "keys", ":id", "devices"],
      access: "admin",
      async handler({ session, params, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(keyIdSchema, params.id);
        const devices = await service.adminDevices(session, keyId);
        return jsonResponse({ devices }, { status: 200, requestId });
      },
    },
  ];
}
