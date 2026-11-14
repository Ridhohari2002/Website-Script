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
 *
 * Rate limiting is split by trust boundary:
 * - The route applies an IP bucket before body parsing and before any database
 *   work, but only when the request carries the configured trusted-proxy marker
 *   and exactly one valid forwarded address. Without that proof the IP bucket is
 *   omitted rather than collapsing every client into one "unknown" bucket. The
 *   IP bucket is a coarse abuse guard, never an authorization decision.
 * - Per-key and per-session buckets are applied inside the executor service,
 *   after the key or session has been identified through its server-side HMAC
 *   hash. Client headers such as `x-key-fingerprint` are ignored entirely.
 */

const WINDOW_SECONDS = 60;
const ACTIVATE_IP_LIMIT = 20;
const VALIDATE_IP_LIMIT = 240;
const REVOKE_IP_LIMIT = 60;

function ipDimension(context: RouteContext, limit: number): RateLimitDimension[] {
  const ip = clientIp(context.request);
  // No verified proxy marker means no trustworthy IP. Returning no dimension is
  // deliberate: a shared "unknown" bucket would treat an unlimited set of
  // clients as if they were one rate-limited identity.
  if (!ip) return [];
  return [{ kind: "ip", value: ip, limit, windowSeconds: WINDOW_SECONDS }];
}

const idSchema = z.string().uuid();

export function executorRoutes(service: ExecutorService): RouteDefinition[] {
  return [
    {
      method: "POST",
      pattern: ["executor", "v1", "activate"],
      rateLimit: (context) => ipDimension(context, ACTIVATE_IP_LIMIT),
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
      rateLimit: (context) => ipDimension(context, VALIDATE_IP_LIMIT),
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
      rateLimit: (context) => ipDimension(context, REVOKE_IP_LIMIT),
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
