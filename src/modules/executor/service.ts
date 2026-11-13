import {
  getConfiguredKeySecret,
  getHwidSecret,
  getKeySecretState,
  getSessionSecret,
} from "@/core/env";
import { clientIp, userAgent } from "@/core/request-meta";
import { badRequest, notFound, rateLimited } from "@/core/errors";
import { HwidNormalizationError, hashHwid, hwidFingerprint } from "@/core/crypto/hwid";
import type { Db, DbExecutor } from "@/db/client";
import { getSqlDb } from "@/db/client";
import { constantTimeEqualHex } from "@/db/hashing";
import { rateLimiter as defaultRateLimiter, type RateLimiter } from "@/db/rate-limit-store";
import { resolveScriptAccess } from "@/modules/access/script-access";
import { createOpaqueToken } from "@/modules/auth/crypto";
import { writeKeyAuditLog, type KeyAuditAction } from "@/modules/keys/audit";
import {
  hashExecutorNonce,
  hashExecutorSessionToken,
  hashKeyValue,
  type KeyHashVersion,
} from "@/modules/keys/crypto";
import { keyDenied, type KeyDenialCode } from "@/modules/keys/errors";

/**
 * Executor-first license activation.
 *
 * The executor is untrusted: it holds no server secret and cannot prove it is a
 * genuine Roblox client. Every decision is made server-side from the license
 * key, the HMAC-bound HWID, the executor session, the product entitlement, and
 * a consumed nonce.
 */

export const EXECUTOR_IDLE_MS = 30 * 60 * 1000;
export const EXECUTOR_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const EXECUTOR_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
export const EXECUTOR_NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * Server-side key/session limits run inside the service, after the key or
 * session has been identified through a server-side hash lookup. The route-level
 * IP limit still runs first, before the body is read.
 *
 * The bucket value is always a server-derived identifier (`keys.id` or
 * `executor_sessions.id`), never a raw key, token, or client header. The rate
 * limiter itself HMACs the value again before storage.
 */
const KEY_LIMIT_WINDOW_SECONDS = 60;
const ACTIVATE_KEY_LIMIT = 5;
const VALIDATE_SESSION_LIMIT = 120;
const REVOKE_SESSION_LIMIT = 10;

export interface ExecutorServiceDeps {
  db?: Db;
  clock?: () => Date;
  sessionSecret?: string;
  keySecret?: string;
  keySecretVersion?: KeyHashVersion;
  hwidSecret?: string;
  limiter?: RateLimiter;
  idleMs?: number;
  absoluteMs?: number;
  timestampToleranceMs?: number;
  nonceTtlMs?: number;
}

export interface ExecutorActivateInput {
  request: Request;
  key: string;
  hwid: string;
  scriptId: string;
  clientVersion?: string;
  robloxUserId?: string;
  robloxUsername?: string;
  executorName?: string;
  executorVersion?: string;
}

export interface ExecutorActivationBody {
  keyId: string;
  sessionId: string;
  status: "active";
  sessionToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  firstClaim: boolean;
  reactivated: boolean;
  activationCount: number;
  scriptId: string;
  entitlementId: string;
  productId: string;
}

export interface ExecutorValidateInput {
  request: Request;
  sessionToken: string;
  scriptId: string;
  hwid: string;
  timestamp: string | number;
  nonce: string;
  clientVersion?: string;
}

export interface ExecutorValidationBody {
  valid: true;
  scriptId: string;
  keyId: string;
  sessionId: string;
  grantId: string;
  entitlementId: string;
  grantExpiresAt: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface ExecutorRevokeResult {
  sessionId: string;
  revoked: boolean;
  alreadyRevoked: boolean;
  /**
   * Explicit outcome so a superseded session can never be reported as a fresh
   * revocation, and the caller can tell the three terminal states apart.
   */
  outcome: "revoked" | "already_revoked" | "superseded" | "expired";
  status: ExecutorSessionStatus;
}

export interface ExecutorSessionView {
  id: string;
  keyId: string;
  status: string;
  hwidFingerprint: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  robloxUserId: string | null;
  robloxUsername: string | null;
  executorName: string | null;
  executorVersion: string | null;
  clientVersion: string | null;
}

export interface ExecutorService {
  activate(input: ExecutorActivateInput): Promise<ExecutorActivationBody>;
  validate(input: ExecutorValidateInput): Promise<ExecutorValidationBody>;
  revokeSession(input: { request: Request; sessionToken: string }): Promise<ExecutorRevokeResult>;
  listKeySessions(keyId: string): Promise<ExecutorSessionView[]>;
  adminRevokeSession(input: {
    keyId: string;
    sessionId: string;
    adminUserId: string;
    request: Request;
  }): Promise<ExecutorRevokeResult>;
}

type ExecutorSessionStatus = "active" | "superseded" | "expired" | "revoked";

interface KeyRow {
  id: string;
  key_hash: string;
  key_hash_version: KeyHashVersion;
  status: "unused" | "active" | "expired" | "revoked" | "suspended" | "banned";
  owner_discord_id: string | null;
  user_id: string | null;
  bound_hwid_hash: string | null;
  activation_count: number;
  max_activations: number;
  expires_at: Date | string | null;
  claimed_at: Date | string | null;
  claim_kind: "executor" | "discord" | null;
  claim_ref: string | null;
  executor_claim_authorized_at: Date | string | null;
  product_id: string | null;
}

interface SessionRow {
  id: string;
  key_id: string;
  session_token_hash: string;
  session_token_hash_version: KeyHashVersion;
  hwid_hash: string;
  hwid_fingerprint: string;
  status: ExecutorSessionStatus;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
  created_at: Date | string;
  roblox_user_id: string | null;
  roblox_username: string | null;
  executor_name: string | null;
  executor_version: string | null;
  client_version: string | null;
}

type DenialEffect = (db: DbExecutor) => Promise<void>;

class ExecutorDenialSignal extends Error {
  constructor(
    readonly code: KeyDenialCode,
    readonly audit: {
      action: KeyAuditAction;
      keyId: string | null;
      metadata: Record<string, unknown>;
      ip: string | null;
    },
    readonly effects: DenialEffect[] = [],
  ) {
    super(code);
    this.name = "ExecutorDenialSignal";
  }
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function parseTimestamp(value: string | number): number | null {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function terminalDenial(
  status: KeyRow["status"],
): Extract<KeyDenialCode, "banned_key" | "revoked_key" | "suspended_key"> | null {
  if (status === "banned") return "banned_key";
  if (status === "revoked") return "revoked_key";
  if (status === "suspended") return "suspended_key";
  return null;
}

export class PostgresExecutorService implements ExecutorService {
  private readonly db: Db;
  private readonly clock: () => Date;
  private readonly sessionSecretOverride: string | undefined;
  private readonly keySecretOverride: string | undefined;
  private readonly keySecretVersionOverride: KeyHashVersion | undefined;
  private readonly hwidSecretOverride: string | undefined;
  private readonly limiter: RateLimiter;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly timestampToleranceMs: number;
  private readonly nonceTtlMs: number;

  constructor(deps: ExecutorServiceDeps = {}) {
    this.db = deps.db ?? getSqlDb();
    this.clock = deps.clock ?? (() => new Date());
    this.sessionSecretOverride = deps.sessionSecret;
    this.keySecretOverride = deps.keySecret;
    this.keySecretVersionOverride = deps.keySecretVersion;
    this.hwidSecretOverride = deps.hwidSecret;
    this.limiter = deps.limiter ?? defaultRateLimiter;
    this.idleMs = deps.idleMs ?? EXECUTOR_IDLE_MS;
    this.absoluteMs = deps.absoluteMs ?? EXECUTOR_ABSOLUTE_MS;
    this.timestampToleranceMs = deps.timestampToleranceMs ?? EXECUTOR_TIMESTAMP_TOLERANCE_MS;
    this.nonceTtlMs = deps.nonceTtlMs ?? EXECUTOR_NONCE_TTL_MS;
  }

  private get sessionSecret(): string {
    return this.sessionSecretOverride ?? getSessionSecret();
  }

  private get hwidSecret(): string {
    return this.hwidSecretOverride ?? getHwidSecret();
  }

  private get keyHashState(): { secret: string; version: KeyHashVersion } {
    if (this.keySecretOverride) {
      return { secret: this.keySecretOverride, version: this.keySecretVersionOverride ?? "v2" };
    }
    return getKeySecretState();
  }

  /**
   * Read-side material. Verification never depends on the write secret: a
   * deployment can verify legacy version 1 keys with SESSION_HMAC_SECRET even
   * after the dedicated secret is configured.
   */
  private configuredKeySecret(): { secret: string; version: KeyHashVersion } | null {
    if (this.keySecretOverride) {
      return {
        secret: this.keySecretOverride,
        version: this.keySecretVersionOverride ?? "v2",
      };
    }
    return getConfiguredKeySecret();
  }

  private keyHashCandidates(plaintext: string): string[] {
    const candidates: string[] = [];
    const configured = this.configuredKeySecret();
    if (configured) {
      candidates.push(hashKeyValue(plaintext, configured.secret, configured.version));
    }
    candidates.push(hashKeyValue(plaintext, this.sessionSecret, "v1"));
    return [...new Set(candidates)];
  }

  private sessionTokenCandidates(token: string): string[] {
    const candidates: string[] = [];
    const configured = this.configuredKeySecret();
    if (configured) {
      candidates.push(hashExecutorSessionToken(token, configured.secret, configured.version));
    }
    candidates.push(hashExecutorSessionToken(token, this.sessionSecret, "v1"));
    return [...new Set(candidates)];
  }

  /**
   * Consumes one key/session bucket. The value is the server-side row id, so a
   * client cannot choose or rotate the bucket. Denial is generic and uses the
   * same `rate_limited` surface as the route-level IP limit.
   */
  private async enforceLimit(kind: "key", value: string, limit: number): Promise<void> {
    const decision = await this.limiter.consume([
      { kind, value, limit, windowSeconds: KEY_LIMIT_WINDOW_SECONDS },
    ]);
    if (!decision.allowed) throw rateLimited();
  }

  private async keyIdForLimit(keyHashes: string[]): Promise<string | null> {
    const found = await this.db.query<{ id: string }>(
      "select id from keys where key_hash = any($1::text[])",
      [keyHashes],
    );
    return found.rows[0]?.id ?? null;
  }

  private async sessionIdForLimit(tokenHashes: string[]): Promise<string | null> {
    const found = await this.db.query<{ id: string }>(
      "select id from executor_sessions where session_token_hash = any($1::text[])",
      [tokenHashes],
    );
    return found.rows[0]?.id ?? null;
  }

  private async persistDenial<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ExecutorDenialSignal) {
        try {
          await this.db.transaction(async (tx) => {
            await writeKeyAuditLog(tx, {
              actorUserId: null,
              actorType: "executor",
              action: error.audit.action,
              targetId: error.audit.keyId,
              metadata: error.audit.metadata,
              ip: error.audit.ip,
            });
            for (const effect of error.effects) await effect(tx);
          });
        } catch {
          // The denial is authoritative; a failed audit sink must not change it.
        }
        throw keyDenied(error.code);
      }
      throw error;
    }
  }

  async activate(input: ExecutorActivateInput): Promise<ExecutorActivationBody> {
    const keyHashes = this.keyHashCandidates(input.key);
    const ip = clientIp(input.request);

    // Identify the key through the server-side hash before spending the
    // per-key bucket. Unknown keys are covered by the route IP limit and never
    // create a key bucket, so a caller cannot probe key existence through timing
    // or bucket names.
    const limitedKeyId = await this.keyIdForLimit(keyHashes);
    if (limitedKeyId) await this.enforceLimit("key", limitedKeyId, ACTIVATE_KEY_LIMIT);

    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const now = this.clock();
        const found = await tx.query<KeyRow>(
          "select * from keys where key_hash = any($1::text[]) for update",
          [keyHashes],
        );
        const row = found.rows[0];
        if (!row) {
          return this.deny(tx, null, "executor.activate_failed", "invalid_key", "unknown key", ip);
        }

        const terminal = terminalDenial(row.status);
        if (terminal) {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            terminal,
            `status=${row.status}`,
            ip,
          );
        }
        if (row.status === "expired") {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            "expired_key",
            "status=expired",
            ip,
          );
        }
        const keyExpiresAt = toDate(row.expires_at);
        if (keyExpiresAt && keyExpiresAt.getTime() <= now.getTime()) {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            "expired_key",
            "key expired",
            ip,
          );
        }
        if (row.status !== "unused" && row.status !== "active") {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            "key_not_active",
            `status=${row.status}`,
            ip,
          );
        }

        let hwidHash: string;
        try {
          hwidHash = hashHwid(input.hwid, this.hwidSecret);
        } catch (error) {
          if (error instanceof HwidNormalizationError) throw badRequest("Invalid hwid");
          throw error;
        }
        const fingerprint = hwidFingerprint(hwidHash);

        if (row.bound_hwid_hash && !constantTimeEqualHex(hwidHash, row.bound_hwid_hash)) {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            "hwid_mismatch",
            "hwid does not match the bound device",
            ip,
            [
              async (db) => {
                await this.deviceEvent(
                  db,
                  row.id,
                  "executor_validation_failed",
                  fingerprint,
                  ip,
                  now,
                  {
                    reason: "hwid_mismatch",
                  },
                );
              },
            ],
          );
        }

        const access = await resolveScriptAccess(tx, {
          keyId: row.id,
          publicId: input.scriptId,
          now,
        });
        if (!access.ok) {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            access.code,
            `script access denied: ${access.code}`,
            ip,
          );
        }

        /**
         * Claim classification.
         *
         * A key claimed through the Phase 4 Discord flow is not a fresh executor
         * claim merely because it has no HWID. It stays a Discord claim:
         * - with a matching bound HWID it is a recovery/reactivation;
         * - with no HWID it is ambiguous and must be authorized by an admin.
         * Only a key with no claim evidence can enter the first-claim path.
         */
        const hasLegacyClaim =
          row.claim_kind === "discord" ||
          row.owner_discord_id !== null ||
          row.claimed_at !== null ||
          row.activation_count > 0;

        let claimMode: "unclaimed" | "executor" | "legacy_authorized" | "legacy_recovery";
        if (row.claim_kind === "executor") {
          claimMode = "executor";
        } else if (row.executor_claim_authorized_at !== null) {
          claimMode = "legacy_authorized";
        } else if (hasLegacyClaim) {
          if (row.bound_hwid_hash && constantTimeEqualHex(hwidHash, row.bound_hwid_hash)) {
            claimMode = "legacy_recovery";
          } else {
            return this.deny(
              tx,
              row.id,
              "executor.activate_failed",
              "already_owned",
              "legacy Discord claim requires explicit admin authorization",
              ip,
            );
          }
        } else {
          claimMode = "unclaimed";
        }

        const bindDevice = row.bound_hwid_hash === null;
        const firstClaim = claimMode === "unclaimed";
        if (firstClaim && row.activation_count >= row.max_activations) {
          return this.deny(
            tx,
            row.id,
            "executor.activate_failed",
            "invalid_key",
            "activation cap reached",
            ip,
          );
        }

        // One active executor session per key: the previous one is replaced in
        // the same transaction that creates the new one.
        const superseded = await tx.query<{ id: string }>(
          `update executor_sessions
              set status = 'superseded', revoked_at = $2
            where key_id = $1 and status = 'active'
            returning id`,
          [row.id, now.toISOString()],
        );

        const sessionToken = createOpaqueToken();
        const state = this.keyHashState;
        const idleExpiresAt = new Date(now.getTime() + this.idleMs);
        const absoluteExpiresAt = new Date(now.getTime() + this.absoluteMs);
        const inserted = await tx.query<{ id: string }>(
          `insert into executor_sessions
             (key_id, session_token_hash, session_token_hash_version, hwid_hash, hwid_fingerprint,
              status, idle_expires_at, absolute_expires_at, last_seen_at,
              roblox_user_id, roblox_username, executor_name, executor_version, client_version,
              ip, user_agent, created_at)
           values ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $8)
           returning id`,
          [
            row.id,
            hashExecutorSessionToken(sessionToken, state.secret, state.version),
            state.version,
            hwidHash,
            fingerprint,
            idleExpiresAt.toISOString(),
            absoluteExpiresAt.toISOString(),
            now.toISOString(),
            input.robloxUserId ?? null,
            input.robloxUsername ?? null,
            input.executorName ?? null,
            input.executorVersion ?? null,
            input.clientVersion ?? null,
            ip,
            userAgent(input.request),
          ],
        );
        const sessionId = inserted.rows[0]!.id;

        // activation_count tracks first executor bindings only. Recoveries,
        // reactivations, and admin-authorized legacy migrations never consume a
        // new activation. Buyer identity columns are never written here.
        const activationCount = firstClaim ? row.activation_count + 1 : row.activation_count;
        const claimKind = claimMode === "legacy_recovery" ? row.claim_kind : "executor";
        await tx.query(
          `update keys
              set status = 'active',
                  bound_hwid_hash = case when $2 then $3 else bound_hwid_hash end,
                  hwid_bound_at = case when $2 then $4 else hwid_bound_at end,
                  claimed_at = case when $2 then coalesce(claimed_at, $4) else claimed_at end,
                  claim_kind = $5,
                  claim_ref = case when $2 then coalesce(claim_ref, $6) else claim_ref end,
                  activation_count = $7,
                  updated_at = $4
            where id = $1`,
          [
            row.id,
            bindDevice,
            hwidHash,
            now.toISOString(),
            claimKind,
            input.executorName ? `executor:${input.executorName}`.slice(0, 120) : "executor",
            activationCount,
          ],
        );

        await this.deviceEvent(
          tx,
          row.id,
          firstClaim ? "executor_activated" : "executor_reactivated",
          fingerprint,
          ip,
          now,
          {
            sessionId,
            claimMode,
            executorName: input.executorName ?? null,
            executorVersion: input.executorVersion ?? null,
            scriptId: access.script.publicId,
          },
        );
        if (superseded.rowCount && superseded.rowCount > 0) {
          await this.deviceEvent(tx, row.id, "executor_session_replaced", fingerprint, ip, now, {
            previousSessionId: superseded.rows[0]?.id ?? null,
            newSessionId: sessionId,
          });
        }

        await writeKeyAuditLog(tx, {
          actorUserId: null,
          actorType: "executor",
          actorRef: sessionId,
          action: "executor.activate",
          targetId: row.id,
          metadata: {
            sessionId,
            scriptId: access.script.publicId,
            productId: access.productId,
            firstClaim,
            claimMode,
            reactivated: !firstClaim,
            replacedSession: superseded.rows[0]?.id ?? null,
          },
          ip,
        });

        return {
          keyId: row.id,
          sessionId,
          status: "active" as const,
          sessionToken,
          idleExpiresAt: idleExpiresAt.toISOString(),
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
          firstClaim,
          reactivated: !firstClaim,
          activationCount,
          scriptId: access.script.publicId,
          entitlementId: access.entitlementId,
          productId: access.productId,
        };
      }),
    );
  }

  async validate(input: ExecutorValidateInput): Promise<ExecutorValidationBody> {
    const tokenHashes = this.sessionTokenCandidates(input.sessionToken);
    const ip = clientIp(input.request);

    // Per-session budget, keyed by the server-side session id. The IP limit has
    // already run in the route pipeline.
    const limitedSessionId = await this.sessionIdForLimit(tokenHashes);
    if (limitedSessionId) {
      await this.enforceLimit("key", limitedSessionId, VALIDATE_SESSION_LIMIT);
    }

    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const now = this.clock();

        // Lock order is always keys -> executor_sessions. The session is first
        // identified without a lock only to learn its key; the key is then
        // locked and the session is read again under its own lock. The unlocked
        // lookup is never used for authorization.
        const sessionLookup = await tx.query<{ id: string; key_id: string }>(
          "select id, key_id from executor_sessions where session_token_hash = any($1::text[])",
          [tokenHashes],
        );
        const sessionRef = sessionLookup.rows[0];
        if (!sessionRef) {
          return this.deny(
            tx,
            null,
            "executor.validate_failed",
            "session_required",
            "unknown executor session",
            ip,
          );
        }

        const keyResult = await tx.query<KeyRow>("select * from keys where id = $1 for update", [
          sessionRef.key_id,
        ]);
        const key = keyResult.rows[0];
        if (!key) {
          return this.deny(
            tx,
            sessionRef.key_id,
            "executor.validate_failed",
            "invalid_key",
            "key missing",
            ip,
          );
        }

        const sessionResult = await tx.query<SessionRow>(
          "select * from executor_sessions where id = $1 and key_id = $2 for update",
          [sessionRef.id, key.id],
        );
        const session = sessionResult.rows[0];
        if (!session) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "session_required",
            "session missing after key lock",
            ip,
          );
        }

        if (session.status !== "active") {
          const code =
            session.status === "revoked" || session.status === "superseded"
              ? "session_revoked"
              : "session_expired";
          return this.deny(
            tx,
            session.key_id,
            "executor.validate_failed",
            code,
            `session status=${session.status}`,
            ip,
            [this.expireSessionEffect(session.id, now)],
          );
        }

        const absoluteExpiresAt = toDate(session.absolute_expires_at)!;
        if (absoluteExpiresAt.getTime() <= now.getTime()) {
          return this.deny(
            tx,
            session.key_id,
            "executor.validate_failed",
            "session_expired",
            "absolute expiry",
            ip,
            [this.expireSessionEffect(session.id, now)],
          );
        }
        const idleExpiresAt = toDate(session.idle_expires_at)!;
        if (idleExpiresAt.getTime() <= now.getTime()) {
          return this.deny(
            tx,
            session.key_id,
            "executor.validate_failed",
            "session_expired",
            "idle expiry",
            ip,
            [this.expireSessionEffect(session.id, now)],
          );
        }

        const terminal = terminalDenial(key.status);
        if (terminal) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            terminal,
            `status=${key.status}`,
            ip,
          );
        }
        if (key.status !== "active") {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "key_not_active",
            `status=${key.status}`,
            ip,
          );
        }
        const keyExpiresAt = toDate(key.expires_at);
        if (keyExpiresAt && keyExpiresAt.getTime() <= now.getTime()) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "expired_key",
            "key expired",
            ip,
          );
        }

        let hwidHash: string;
        try {
          hwidHash = hashHwid(input.hwid, this.hwidSecret);
        } catch (error) {
          if (error instanceof HwidNormalizationError) throw badRequest("Invalid hwid");
          throw error;
        }
        const fingerprint = hwidFingerprint(hwidHash);
        const sessionMatch = constantTimeEqualHex(hwidHash, session.hwid_hash);
        const keyMatch = key.bound_hwid_hash
          ? constantTimeEqualHex(hwidHash, key.bound_hwid_hash)
          : true;
        if (!sessionMatch || !keyMatch) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "hwid_mismatch",
            "hwid does not match the session binding",
            ip,
            [
              async (db) => {
                await this.deviceEvent(
                  db,
                  key.id,
                  "executor_validation_failed",
                  fingerprint,
                  ip,
                  now,
                  { reason: "hwid_mismatch" },
                );
              },
            ],
          );
        }

        const suppliedAt = parseTimestamp(input.timestamp);
        if (
          suppliedAt === null ||
          Math.abs(now.getTime() - suppliedAt) > this.timestampToleranceMs
        ) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "timestamp_invalid",
            "timestamp outside the accepted window",
            ip,
          );
        }

        const access = await resolveScriptAccess(tx, {
          keyId: key.id,
          publicId: input.scriptId,
          now,
        });
        if (!access.ok) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            access.code,
            `script access denied: ${access.code}`,
            ip,
          );
        }

        const nonceHash = hashExecutorNonce(input.nonce, this.keyHashState.secret, session.id);
        const nonceInsert = await tx.query<{ id: string }>(
          `insert into executor_nonces (nonce_hash, session_id, key_id, used_at, expires_at)
           values ($1, $2, $3, $4, $5)
           on conflict (nonce_hash) do nothing
           returning id`,
          [
            nonceHash,
            session.id,
            key.id,
            now.toISOString(),
            new Date(now.getTime() + this.nonceTtlMs).toISOString(),
          ],
        );
        if (nonceInsert.rowCount === 0) {
          return this.deny(
            tx,
            key.id,
            "executor.validate_failed",
            "replay_detected",
            "nonce already used",
            ip,
          );
        }

        const nextIdle = new Date(
          Math.min(now.getTime() + this.idleMs, absoluteExpiresAt.getTime()),
        );
        await tx.query(
          `update executor_sessions
              set last_seen_at = $2, idle_expires_at = $3
            where id = $1`,
          [session.id, now.toISOString(), nextIdle.toISOString()],
        );

        const grant = await tx.query<{ id: string }>(
          `insert into script_access_logs
             (script_id, version_id, actor_user_id, key_id, executor_session_id, entitlement_id,
              grant_expires_at, ip, user_agent, result, created_at)
           values ($1, $2, null, $3, $4, $5, $6, $7, $8, 'granted', $9)
           returning id`,
          [
            access.script.scriptId,
            access.script.versionId,
            key.id,
            session.id,
            access.entitlementId,
            access.grantExpiresAt,
            ip,
            input.clientVersion ?? null,
            now.toISOString(),
          ],
        );

        await writeKeyAuditLog(tx, {
          actorUserId: null,
          actorType: "executor",
          actorRef: session.id,
          action: "executor.validate",
          targetId: key.id,
          metadata: {
            sessionId: session.id,
            scriptId: access.script.publicId,
            grantId: grant.rows[0]!.id,
            clientVersion: input.clientVersion ?? null,
          },
          ip,
        });

        return {
          valid: true as const,
          scriptId: access.script.publicId,
          keyId: key.id,
          sessionId: session.id,
          grantId: grant.rows[0]!.id,
          entitlementId: access.entitlementId,
          grantExpiresAt: access.grantExpiresAt,
          idleExpiresAt: nextIdle.toISOString(),
          absoluteExpiresAt: absoluteExpiresAt.toISOString(),
        };
      }),
    );
  }

  async revokeSession(input: {
    request: Request;
    sessionToken: string;
  }): Promise<ExecutorRevokeResult> {
    const tokenHashes = this.sessionTokenCandidates(input.sessionToken);
    const ip = clientIp(input.request);

    const limitedSessionId = await this.sessionIdForLimit(tokenHashes);
    if (limitedSessionId) await this.enforceLimit("key", limitedSessionId, REVOKE_SESSION_LIMIT);

    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const now = this.clock();

        // Lock order is always keys -> executor_sessions. Identify the session
        // without a lock only to learn its key, then lock the key before the
        // session row and re-read the session under that lock.
        const sessionLookup = await tx.query<{ id: string; key_id: string }>(
          "select id, key_id from executor_sessions where session_token_hash = any($1::text[])",
          [tokenHashes],
        );
        const sessionRef = sessionLookup.rows[0];
        if (!sessionRef) {
          return this.deny(
            tx,
            null,
            "executor.session_revoke_failed",
            "session_required",
            "unknown executor session",
            ip,
          );
        }

        const keyResult = await tx.query<{ id: string }>(
          "select id from keys where id = $1 for update",
          [sessionRef.key_id],
        );
        const key = keyResult.rows[0];
        if (!key) {
          return this.deny(
            tx,
            sessionRef.key_id,
            "executor.session_revoke_failed",
            "invalid_key",
            "key missing",
            ip,
          );
        }

        const found = await tx.query<SessionRow>(
          "select * from executor_sessions where id = $1 and key_id = $2 for update",
          [sessionRef.id, key.id],
        );
        const session = found.rows[0];
        if (!session) {
          return this.deny(
            tx,
            key.id,
            "executor.session_revoke_failed",
            "session_required",
            "session missing after key lock",
            ip,
          );
        }

        // Only the calling session is ever touched. The key row, buyer identity,
        // and every other session (active or not) are left untouched.
        switch (session.status) {
          case "revoked":
            return {
              sessionId: session.id,
              revoked: false,
              alreadyRevoked: true,
              outcome: "already_revoked" as const,
              status: session.status,
            };
          case "superseded":
            return {
              sessionId: session.id,
              revoked: false,
              alreadyRevoked: false,
              outcome: "superseded" as const,
              status: session.status,
            };
          case "expired":
            return {
              sessionId: session.id,
              revoked: false,
              alreadyRevoked: false,
              outcome: "expired" as const,
              status: session.status,
            };
          case "active":
            break;
        }

        const updated = await tx.query(
          `update executor_sessions
            set status = 'revoked', revoked_at = $2
          where id = $1 and status = 'active'`,
          [session.id, now.toISOString()],
        );
        if (updated.rowCount === 0) {
          // A concurrent transition won; report the state honestly without
          // writing a second revocation audit.
          return {
            sessionId: session.id,
            revoked: false,
            alreadyRevoked: true,
            outcome: "already_revoked" as const,
            status: "revoked" as const,
          };
        }

        await this.deviceEvent(
          tx,
          session.key_id,
          "executor_session_revoked",
          session.hwid_fingerprint,
          ip,
          now,
          { sessionId: session.id, actor: "executor" },
        );
        await writeKeyAuditLog(tx, {
          actorUserId: null,
          actorType: "executor",
          actorRef: session.id,
          action: "executor.session_revoke",
          targetId: session.key_id,
          metadata: { sessionId: session.id, outcome: "revoked" },
          ip,
        });
        return {
          sessionId: session.id,
          revoked: true,
          alreadyRevoked: false,
          outcome: "revoked" as const,
          status: "revoked" as const,
        };
      }),
    );
  }

  async adminRevokeSession(input: {
    keyId: string;
    sessionId: string;
    adminUserId: string;
    request: Request;
  }): Promise<ExecutorRevokeResult> {
    return this.db.transaction(async (tx) => {
      const now = this.clock();

      // Same keys -> executor_sessions order as every other executor and key
      // transaction. The key is locked even though only the session changes, so
      // an admin revoke cannot interleave with activation or validation.
      const keyResult = await tx.query<{ id: string }>(
        "select id from keys where id = $1 for update",
        [input.keyId],
      );
      if (!keyResult.rows[0]) throw notFound("Session not found");

      const found = await tx.query<SessionRow>(
        "select * from executor_sessions where id = $1 and key_id = $2 for update",
        [input.sessionId, input.keyId],
      );
      const session = found.rows[0];
      if (!session) throw notFound("Session not found");
      if (session.status !== "active") {
        return {
          sessionId: session.id,
          revoked: false,
          alreadyRevoked: session.status === "revoked",
          outcome:
            session.status === "revoked"
              ? ("already_revoked" as const)
              : session.status === "superseded"
                ? ("superseded" as const)
                : ("expired" as const),
          status: session.status,
        };
      }
      await tx.query(
        `update executor_sessions
            set status = 'revoked', revoked_at = $2
          where id = $1`,
        [session.id, now.toISOString()],
      );
      await this.deviceEvent(
        tx,
        session.key_id,
        "executor_session_revoked",
        session.hwid_fingerprint,
        clientIp(input.request),
        now,
        { sessionId: session.id, actor: "admin" },
      );
      await writeKeyAuditLog(tx, {
        actorUserId: input.adminUserId,
        actorType: "admin",
        actorRef: session.id,
        action: "executor.session_revoke_admin",
        targetId: session.key_id,
        metadata: { sessionId: session.id, outcome: "revoked" },
        ip: clientIp(input.request),
      });
      return {
        sessionId: session.id,
        revoked: true,
        alreadyRevoked: false,
        outcome: "revoked" as const,
        status: "revoked" as const,
      };
    });
  }

  async listKeySessions(keyId: string): Promise<ExecutorSessionView[]> {
    const result = await this.db.query<SessionRow>(
      `select * from executor_sessions
        where key_id = $1
        order by created_at desc, id desc`,
      [keyId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      keyId: row.key_id,
      status: row.status,
      hwidFingerprint: row.hwid_fingerprint,
      createdAt: iso(row.created_at)!,
      lastSeenAt: iso(row.last_seen_at)!,
      idleExpiresAt: iso(row.idle_expires_at)!,
      absoluteExpiresAt: iso(row.absolute_expires_at)!,
      revokedAt: iso(row.revoked_at),
      robloxUserId: row.roblox_user_id,
      robloxUsername: row.roblox_username,
      executorName: row.executor_name,
      executorVersion: row.executor_version,
      clientVersion: row.client_version,
    }));
  }

  private deny(
    _tx: DbExecutor,
    keyId: string | null,
    action: KeyAuditAction,
    code: KeyDenialCode,
    reason: string,
    ip: string | null,
    effects: DenialEffect[] = [],
  ): never {
    throw new ExecutorDenialSignal(
      code,
      { action, keyId, metadata: { code, reason }, ip },
      effects,
    );
  }

  private expireSessionEffect(sessionId: string, now: Date): DenialEffect {
    return async (db) => {
      await db.query(
        `update executor_sessions
            set status = 'expired', revoked_at = coalesce(revoked_at, $2)
          where id = $1 and status = 'active'`,
        [sessionId, now.toISOString()],
      );
    };
  }

  private async deviceEvent(
    db: DbExecutor,
    keyId: string,
    event: string,
    fingerprint: string | null,
    ip: string | null,
    now: Date,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      `insert into key_device_history
         (key_id, event, hwid_fingerprint, ip, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [keyId, event, fingerprint, ip, JSON.stringify(metadata), now.toISOString()],
    );
  }
}

export function createExecutorService(deps: ExecutorServiceDeps = {}): ExecutorService {
  return new PostgresExecutorService(deps);
}
