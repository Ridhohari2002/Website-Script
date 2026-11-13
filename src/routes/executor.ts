import { z } from "zod";
import { clientIp } from "@/core/request-meta";
import { jsonResponse } from "@/core/response";
import { readJsonBody } from "@/middleware/body-limit";
import { validate } from "@/middleware/validation";
import type { RouteContext, RouteDefinition } from "@/http/router";
import type { RateLimitDimension } from "@/db/rate-limit-store";
import type { ExecutorService } from "@/modules/executor/service";
import { bearerToken } from "@/validators/keys";
import { executorActivateSchema, executorValidateSchema } from "@/validators/executor";

/**
 * `/api/executor/v1` endpoints. These routes are public by design: the license
 * key and executor session token are the credentials, and no Discord session is
 * involved. Authorization happens entirely in the executor service.
 */

const WINDOW_SECONDS = 60;
const ACTIVATE_IP_LIMIT = 20;
const ACTIVATE_FINGERPRINT_LIMIT = 5;
const VALIDATE_IP_LIMIT = 240;
const VALIDATE_TOKEN_LIMIT = 120;
const REVOKE_IP_LIMIT = 60;
const REVOKE_TOKEN_LIMIT = 10;

/** Best-effort key fingerprint: the executor may send one for bucketing only. */
const FINGERPRINT = /^[A-Za-z0-9_-]{4,128}$/;

function dimensionsFor(
  context: RouteContext,
  limits: { ip: number; token: number; fingerprint?: number },
): RateLimitDimension[] {
  const dimensions: RateLimitDimension[] = [
    {
      kind: "ip",
      value: clientIp(context.request) ?? "unknown",
      limit: limits.ip,
      windowSeconds: WINDOW_SECONDS,
    },
  ];

  const authorization = context.request.headers.get("authorization");
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? "")?.[1];
  if (bearer) {
    dimensions.push({
      kind: "key",
      value: bearer,
      limit: limits.token,
      windowSeconds: WINDOW_SECONDS,
    });
    return dimensions;
  }

  if (limits.fingerprint) {
    const fingerprint = context.request.headers.get("x-key-fingerprint")?.trim();
    if (fingerprint && FINGERPRINT.test(fingerprint)) {
      dimensions.push({
        kind: "key",
        value: fingerprint,
        limit: limits.fingerprint,
        windowSeconds: WINDOW_SECONDS,
      });
    }
  }
  return dimensions;
}

const idSchema = z.string().uuid();

export function executorRoutes(service: ExecutorService): RouteDefinition[] {
  return [
    {
      method: "POST",
      pattern: ["executor", "v1", "activate"],
      rateLimit: (context) =>
        dimensionsFor(context, {
          ip: ACTIVATE_IP_LIMIT,
          token: ACTIVATE_FINGERPRINT_LIMIT,
          fingerprint: ACTIVATE_FINGERPRINT_LIMIT,
        }),
      async handler({ request, requestId }) {
        const body = validate(executorActivateSchema, await readJsonBody(request));
        const result = await service.activate({
          request,
          key: body.key,
          hwid: body.hwid,
          scriptId: body.scriptId,
          ...(body.clientVersion ? { clientVersion: body.clientVersion } : {}),
          ...(body.robloxUserId ? { robloxUserId: body.robloxUserId } : {}),
          ...(body.robloxUsername ? { robloxUsername: body.robloxUsername } : {}),
          ...(body.executorName ? { executorName: body.executorName } : {}),
          ...(body.executorVersion ? { executorVersion: body.executorVersion } : {}),
        });
        return jsonResponse(result, { status: 201, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["executor", "v1", "validate"],
      rateLimit: (context) =>
        dimensionsFor(context, { ip: VALIDATE_IP_LIMIT, token: VALIDATE_TOKEN_LIMIT }),
      async handler({ request, requestId }) {
        const body = validate(executorValidateSchema, await readJsonBody(request));
        const token = bearerToken(request);
        const result = await service.validate({
          request,
          sessionToken: token,
          scriptId: body.scriptId,
          hwid: body.hwid,
          timestamp: body.timestamp,
          nonce: body.nonce,
          ...(body.clientVersion ? { clientVersion: body.clientVersion } : {}),
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["executor", "v1", "session", "revoke"],
      rateLimit: (context) =>
        dimensionsFor(context, { ip: REVOKE_IP_LIMIT, token: REVOKE_TOKEN_LIMIT }),
      async handler({ request, requestId }) {
        // Revocation is authenticated by the bearer token alone; no body is
        // required and any body is ignored.
        const token = bearerToken(request);
        const result = await service.revokeSession({ request, sessionToken: token });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
    {
      method: "GET",
      pattern: ["admin", "keys", ":id", "sessions"],
      access: "admin",
      async handler({ params, requestId }) {
        const keyId = validate(idSchema, params.id);
        const sessions = await service.listKeySessions(keyId);
        return jsonResponse({ sessions }, { status: 200, requestId });
      },
    },
    {
      method: "POST",
      pattern: ["admin", "keys", ":id", "sessions", ":sessionId", "revoke"],
      access: "admin",
      async handler({ session, params, request, requestId }) {
        if (!session) throw new Error("session missing after access gate");
        const keyId = validate(idSchema, params.id);
        const sessionId = validate(idSchema, params.sessionId);
        const result = await service.adminRevokeSession({
          keyId,
          sessionId,
          adminUserId: session.userId,
          request,
        });
        return jsonResponse(result, { status: 200, requestId });
      },
    },
  ];
}
