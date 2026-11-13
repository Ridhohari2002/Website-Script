import { badRequest, forbidden, notFound } from "@/core/errors";
import { getHwidSecret, getKeySecretState, getSessionSecret } from "@/core/env";
import { HwidNormalizationError, hashHwid, hwidFingerprint } from "@/core/crypto/hwid";
import { clientIp } from "@/core/request-meta";
import type { Db, DbExecutor } from "@/db/client";
import { getSqlDb } from "@/db/client";
import { constantTimeEqualHex } from "@/db/hashing";
import { withIdempotency, type IdempotencyTransaction } from "@/db/idempotency";
import { resolveScriptAccess } from "@/modules/access/script-access";
import type { SessionContext } from "@/middleware/session";
import { createOpaqueToken } from "@/modules/auth/crypto";
import { writeKeyAuditLog, type KeyAuditAction, type KeyAuditEvent } from "@/modules/keys/audit";
import {
  createPlaintextKey,
  hashKeySessionToken,
  hashKeyValue,
  keyDisplayPrefix,
  type KeyHashVersion,
} from "@/modules/keys/crypto";
import { keyDenied, type KeyDenialCode } from "@/modules/keys/errors";

/**
 * Phase 4 key lifecycle (IMPLEMENTATION_PLAN.md §8.6, BACKEND.md §6 and §9.5).
 *
 * Every state-changing path runs in a single transaction and locks the key row
 * before deciding. Ownership and roles come only from the server-resolved
 * session. Plaintext keys and raw HWIDs never enter a response after creation,
 * an audit row, or a log line.
 */

export const KEY_SESSION_TTL_MS = 30 * 60 * 1000;
export const KEY_SESSION_IDLE_MS = 30 * 60 * 1000;
const USAGE_DEDUPE_MS = 60 * 1000;

export interface KeyServiceDeps {
  db?: Db;
  clock?: () => Date;
  sessionSecret?: string;
  /** Dedicated key-hash material. Falls back to `sessionSecret` as version 1. */
  keySecret?: string;
  keySecretVersion?: KeyHashVersion;
  hwidSecret?: string;
  sessionTtlMs?: number;
  idempotencyTtlSeconds?: number;
}

export interface GeneratedKey {
  keyId: string;
  key: string;
  keyPrefix: string;
  type: "free" | "paid";
  status: "unused";
  expiresAt: string | null;
}

export interface GenerateKeysInput {
  session: SessionContext;
  request: Request;
  count: number;
  type: "free" | "paid";
  expiresAt?: string | null;
  maxActivations: number;
  planId?: string | null;
  /** When set, the key is bound to this product and gets an admin entitlement. */
  productId?: string | null;
}

export interface ActivateInput {
  session: SessionContext;
  request: Request;
  key: string;
  hwid?: string;
  deviceLabel?: string;
  idempotencyKey: string;
}

export interface ActivationBody {
  keyId: string;
  status: "active";
  boundAt: string;
  deviceBound: boolean;
  sessionExpiresAt: string;
  reactivationConsumed: boolean;
}

export interface ActivateResult {
  status: number;
  body: ActivationBody & { keySessionToken?: string };
}

export interface ValidateInput {
  session: SessionContext;
  request: Request;
  key: string;
  scriptId: string;
  hwid?: string;
  keySessionToken: string;
}

export interface ValidationBody {
  valid: true;
  scriptId: string;
  keyExpiresAt: string | null;
  sessionExpiresAt: string;
  grantId: string;
}

export interface ResetHwidInput {
  session: SessionContext;
  request: Request;
  keyId: string;
  reason?: string;
  idempotencyKey: string;
}

export interface ResetHwidBody {
  resetAt: string;
  hwidResetCount: number;
  nextResetAllowedAt: string | null;
}

export interface AdminResetHwidInput {
  session: SessionContext;
  request: Request;
  keyId: string;
  reason: string;
}

export interface AdminRevokeInput {
  session: SessionContext;
  request: Request;
  keyId: string;
  reason?: string;
}

export interface AdminListKeysInput {
  status?: string;
  type?: string;
  ownerDiscordId?: string;
  limit: number;
  offset: number;
}

export interface KeyService {
  generateKeys(input: GenerateKeysInput): Promise<GeneratedKey[]>;
  activate(input: ActivateInput): Promise<ActivateResult>;
  validate(input: ValidateInput): Promise<ValidationBody>;
  resetHwid(input: ResetHwidInput): Promise<ResetHwidBody>;
  listOwnKeys(session: SessionContext): Promise<Record<string, unknown>[]>;
  keyUsage(session: SessionContext, keyId: string): Promise<Record<string, unknown>>;
  keyDevices(session: SessionContext, keyId: string): Promise<Record<string, unknown>[]>;
  adminListKeys(input: AdminListKeysInput): Promise<Record<string, unknown>[]>;
  adminRevoke(input: AdminRevokeInput): Promise<Record<string, unknown>>;
  adminResetHwid(input: AdminResetHwidInput): Promise<Record<string, unknown>>;
  adminDevices(session: SessionContext, keyId: string): Promise<Record<string, unknown>[]>;
}

interface KeyRow {
  id: string;
  key_hash: string;
  key_prefix: string | null;
  type: "free" | "paid";
  status: "unused" | "active" | "expired" | "revoked" | "suspended" | "banned";
  owner_discord_id: string | null;
  user_id: string | null;
  bound_hwid_hash: string | null;
  hwid_bound_at: Date | string | null;
  last_hwid_reset_at: Date | string | null;
  hwid_reset_count: number;
  banned_at: Date | string | null;
  ban_reason: string | null;
  subscription_id: string | null;
  max_activations: number;
  activation_count: number;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  product_id: string | null;
  claimed_at: Date | string | null;
  claim_kind: "executor" | "discord" | null;
  claim_ref: string | null;
  key_hash_version: KeyHashVersion;
}

interface KeySessionRow {
  id: string;
  key_id: string;
  user_id: string;
  status: string;
  expires_at: Date | string;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  session_token_hash_version: KeyHashVersion;
}

interface Actor {
  userId: string;
  discordId: string;
}

type DenialEffect = (db: DbExecutor) => Promise<void>;

/**
 * A denial raised inside a transaction must not write its audit row there: the
 * transaction is about to roll back. The signal carries everything needed to
 * persist the audit (and any suspicious-device rows) after rollback.
 */
class KeyDenialSignal extends Error {
  constructor(
    readonly code: KeyDenialCode,
    readonly audit: KeyAuditEvent,
    readonly effects: DenialEffect[] = [],
  ) {
    super(code);
    this.name = "KeyDenialSignal";
  }
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function requireActor(session: SessionContext): Actor {
  if (!session.user?.discordId) {
    throw keyDenied("session_required", "Account session required");
  }
  return { userId: session.userId, discordId: session.user.discordId };
}

/** Terminal status precedence: banned, revoked, suspended, then not-active. */
export function terminalStatusDenial(
  status: KeyRow["status"],
): Extract<KeyDenialCode, "banned_key" | "revoked_key" | "suspended_key"> | null {
  if (status === "banned") return "banned_key";
  if (status === "revoked") return "revoked_key";
  if (status === "suspended") return "suspended_key";
  return null;
}

export class PostgresKeyService implements KeyService {
  private readonly db: Db;
  private readonly clock: () => Date;
  private readonly sessionSecretOverride: string | undefined;
  private readonly keySecretOverride: string | undefined;
  private readonly keySecretVersionOverride: KeyHashVersion | undefined;
  private readonly hwidSecretOverride: string | undefined;
  private readonly sessionTtlMs: number;
  private readonly idempotencyTtlSeconds: number | undefined;
  private readonly transaction: IdempotencyTransaction;

  constructor(deps: KeyServiceDeps = {}) {
    this.db = deps.db ?? getSqlDb();
    this.clock = deps.clock ?? (() => new Date());
    // Secrets are resolved lazily so `next build` can collect route
    // configuration without runtime credentials.
    this.sessionSecretOverride = deps.sessionSecret;
    this.keySecretOverride = deps.keySecret;
    this.keySecretVersionOverride = deps.keySecretVersion;
    this.hwidSecretOverride = deps.hwidSecret;
    this.sessionTtlMs = deps.sessionTtlMs ?? KEY_SESSION_TTL_MS;
    this.idempotencyTtlSeconds = deps.idempotencyTtlSeconds;
    this.transaction = (work) => this.db.transaction(work);
  }

  private get sessionSecret(): string {
    return this.sessionSecretOverride ?? getSessionSecret();
  }

  private get hwidSecret(): string {
    return this.hwidSecretOverride ?? getHwidSecret();
  }

  /**
   * Hash material used for new rows. Version 2 requires the dedicated secret;
   * without it the service writes version 1 so Phase 4 hashes stay consistent.
   */
  private get keyHashState(): { secret: string; version: KeyHashVersion } {
    if (this.keySecretOverride) {
      return {
        secret: this.keySecretOverride,
        version: this.keySecretVersionOverride ?? "v2",
      };
    }
    const configured = getKeySecretState();
    if (configured.version === "v1" && this.sessionSecretOverride) {
      return { secret: this.sessionSecretOverride, version: "v1" };
    }
    return configured;
  }

  private hashKey(plaintext: string): string {
    const state = this.keyHashState;
    return hashKeyValue(plaintext, state.secret, state.version);
  }

  /** Reads try the configured version first, then the legacy version. */
  private keyHashCandidates(plaintext: string): string[] {
    const state = this.keyHashState;
    const candidates = [hashKeyValue(plaintext, state.secret, state.version)];
    if (state.version !== "v1") {
      candidates.push(hashKeyValue(plaintext, this.sessionSecret, "v1"));
    }
    return [...new Set(candidates)];
  }

  private hashSessionToken(token: string): string {
    const state = this.keyHashState;
    return hashKeySessionToken(token, state.secret, state.version);
  }

  private sessionTokenHashCandidates(token: string): string[] {
    const state = this.keyHashState;
    const candidates = [hashKeySessionToken(token, state.secret, state.version)];
    if (state.version !== "v1") {
      candidates.push(hashKeySessionToken(token, this.sessionSecret, "v1"));
    }
    if (this.keySecretOverride) {
      candidates.push(hashKeySessionToken(token, this.keySecretOverride, "v2"));
    }
    return [...new Set(candidates)];
  }

  private async audit(
    db: DbExecutor,
    actorUserId: string | null,
    action: KeyAuditAction,
    keyId: string | null,
    metadata: Record<string, unknown>,
    request?: Request,
  ): Promise<void> {
    await writeKeyAuditLog(db, {
      actorUserId,
      action,
      targetId: keyId,
      metadata,
      ip: request ? clientIp(request) : null,
    });
  }

  private recordDenial(
    _db: DbExecutor,
    actor: Actor | null,
    action: KeyAuditAction,
    keyId: string | null,
    code: KeyDenialCode,
    reason: string,
    request?: Request,
    effects: DenialEffect[] = [],
  ): never {
    throw new KeyDenialSignal(
      code,
      {
        actorUserId: actor?.userId ?? null,
        action,
        targetId: keyId,
        metadata: { code, reason },
        ip: request ? clientIp(request) : null,
      },
      effects,
    );
  }

  /**
   * Runs the operation, persists the denial audit outside its rolled-back
   * transaction, then rethrows the stable external error. A failure to write
   * the audit never masks the original denial.
   */
  private async persistDenial<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KeyDenialSignal) {
        try {
          await this.db.transaction(async (tx) => {
            await writeKeyAuditLog(tx, error.audit);
            for (const effect of error.effects) await effect(tx);
          });
        } catch {
          // The denial is authoritative; a broken audit sink must not change it.
        }
        throw keyDenied(error.code);
      }
      throw error;
    }
  }

  async generateKeys(input: GenerateKeysInput): Promise<GeneratedKey[]> {
    const actor = requireActor(input.session);
    const now = this.clock();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest("Invalid expiresAt");

    return this.db.transaction(async (tx) => {
      const generated: GeneratedKey[] = [];
      for (let index = 0; index < input.count; index += 1) {
        const plaintext = createPlaintextKey();
        const inserted = await tx.query<{ id: string }>(
          `insert into keys
             (key_hash, key_hash_version, key_prefix, type, status, expires_at, max_activations, plan_id, product_id, created_at, updated_at)
           values ($1, $2, $3, $4, 'unused', $5, $6, $7, $8, $9, $9)
           returning id`,
          [
            this.hashKey(plaintext),
            this.keyHashState.version,
            keyDisplayPrefix(plaintext),
            input.type,
            expiresAt ? expiresAt.toISOString() : null,
            input.maxActivations,
            input.planId ?? null,
            input.productId ?? null,
            now.toISOString(),
          ],
        );
        const keyId = inserted.rows[0]!.id;
        if (input.productId) {
          await tx.query(
            `insert into key_entitlements (key_id, product_id, source, status, created_at)
             values ($1, $2, 'admin', 'active', $3)
             on conflict (key_id, product_id) do nothing`,
            [keyId, input.productId, now.toISOString()],
          );
        }
        await this.audit(tx, actor.userId, "key.generate", keyId, {
          type: input.type,
          count: input.count,
        });
        generated.push({
          keyId,
          key: plaintext,
          keyPrefix: keyDisplayPrefix(plaintext),
          type: input.type,
          status: "unused",
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        });
      }
      return generated;
    });
  }

  async activate(input: ActivateInput): Promise<ActivateResult> {
    const actor = requireActor(input.session);
    const keyHashes = this.keyHashCandidates(input.key);
    const idempotencyTtl = this.idempotencyTtlSeconds;

    const result = await this.persistDenial(() =>
      withIdempotency<ActivationBody>({
        scope: "keys.activate",
        key: input.idempotencyKey,
        request: {
          key: input.key,
          hwid: input.hwid ?? null,
          deviceLabel: input.deviceLabel ?? null,
        },
        actorId: actor.userId,
        ...(idempotencyTtl ? { ttlSeconds: idempotencyTtl } : {}),
        transaction: this.transaction,
        run: async (tx) => {
          const now = this.clock();
          const found = await tx.query<KeyRow>(
            "select * from keys where key_hash = any($1::text[]) for update",
            [keyHashes],
          );
          const row = found.rows[0];
          if (!row) {
            return this.failActivation(
              tx,
              actor,
              null,
              "invalid_key",
              "unknown key",
              input.request,
            );
          }

          // Activation has one legitimate terminal-adjacent branch: `suspended`
          // is allowed only with an unused reactivation authorization (below).
          if (row.status === "banned" || row.status === "revoked") {
            const terminal = terminalStatusDenial(row.status)!;
            return this.failActivation(
              tx,
              actor,
              row.id,
              terminal,
              `status=${row.status}`,
              input.request,
            );
          }

          if (row.owner_discord_id && row.owner_discord_id !== actor.discordId) {
            return this.failActivation(
              tx,
              actor,
              row.id,
              "already_owned",
              "owned by another account",
              input.request,
            );
          }

          if (row.status === "active") {
            return this.failActivation(
              tx,
              actor,
              row.id,
              "already_owned",
              "key already active",
              input.request,
            );
          }
          if (row.status !== "unused" && row.status !== "suspended") {
            return this.failActivation(
              tx,
              actor,
              row.id,
              "key_not_active",
              `status=${row.status}`,
              input.request,
            );
          }

          const expiresAt = toDate(row.expires_at);
          if (expiresAt && expiresAt.getTime() <= now.getTime()) {
            return this.failActivation(
              tx,
              actor,
              row.id,
              "expired_key",
              "key expired",
              input.request,
            );
          }
          if (row.activation_count >= row.max_activations) {
            return this.failActivation(
              tx,
              actor,
              row.id,
              "invalid_key",
              "activation cap reached",
              input.request,
            );
          }

          let reactivationConsumed = false;
          if (row.status === "suspended") {
            const authorization = await tx.query<{ id: string }>(
              `select id from key_reactivations
              where key_id = $1 and consumed_at is null
              order by authorized_at desc, id desc
              limit 1
              for update`,
              [row.id],
            );
            const authorizationId = authorization.rows[0]?.id;
            if (!authorizationId) {
              return this.failActivation(
                tx,
                actor,
                row.id,
                "reactivation_not_authorized",
                "suspended key without an unused authorization",
                input.request,
              );
            }
            const consumed = await tx.query(
              `update key_reactivations
                set consumed_at = $2
              where id = $1 and consumed_at is null
              returning id`,
              [authorizationId, now.toISOString()],
            );
            if (consumed.rowCount === 0) {
              return this.failActivation(
                tx,
                actor,
                row.id,
                "reactivation_not_authorized",
                "authorization consumed concurrently",
                input.request,
              );
            }
            reactivationConsumed = true;
          }

          let boundHash: string | null = null;
          try {
            if (input.hwid) boundHash = hashHwid(input.hwid, this.hwidSecret);
          } catch (error) {
            if (error instanceof HwidNormalizationError) {
              throw badRequest("Invalid hwid");
            }
            throw error;
          }

          await tx.query(
            `update key_sessions
              set status = 'superseded', revoked_at = $2
            where key_id = $1 and status = 'active'`,
            [row.id, now.toISOString()],
          );

          const sessionToken = createOpaqueToken();
          const sessionExpiresAt = new Date(now.getTime() + this.sessionTtlMs);
          await tx.query(
            `insert into key_sessions
             (key_id, user_id, session_token_hash, session_token_hash_version, hwid_fingerprint, status, expires_at, last_seen_at, created_at)
           values ($1, $2, $3, $4, $5, 'active', $6, $7, $7)`,
            [
              row.id,
              actor.userId,
              this.hashSessionToken(sessionToken),
              this.keyHashState.version,
              boundHash ? hwidFingerprint(boundHash) : null,
              sessionExpiresAt.toISOString(),
              now.toISOString(),
            ],
          );

          await tx.query(
            `update keys
              set status = 'active',
                  owner_discord_id = $2,
                  user_id = $3,
                  bound_hwid_hash = coalesce($4, bound_hwid_hash),
                  hwid_bound_at = case when $4 is null then hwid_bound_at else $5 end,
                  claimed_at = coalesce(claimed_at, $5),
                  claim_kind = coalesce(claim_kind, 'discord'),
                  claim_ref = coalesce(claim_ref, $2),
                  activation_count = activation_count + 1,
                  updated_at = $5
            where id = $1`,
            [row.id, actor.discordId, actor.userId, boundHash, now.toISOString()],
          );

          if (boundHash) {
            await tx.query(
              `insert into key_device_history
               (key_id, event, hwid_fingerprint, actor_user_id, ip, metadata, created_at)
             values ($1, 'bound', $2, $3, $4, $5, $6)`,
              [
                row.id,
                hwidFingerprint(boundHash),
                actor.userId,
                clientIp(input.request),
                JSON.stringify({ deviceLabel: input.deviceLabel ?? null }),
                now.toISOString(),
              ],
            );
          }

          await this.audit(
            tx,
            actor.userId,
            "key.activate",
            row.id,
            {
              deviceBound: Boolean(boundHash),
              reactivationConsumed,
            },
            input.request,
          );

          if (reactivationConsumed) {
            await this.audit(
              tx,
              actor.userId,
              "key.ban_reactivation_consumed",
              row.id,
              {
                reason: "activation consumed authorization",
              },
              input.request,
            );
          }

          return {
            body: {
              keyId: row.id,
              status: "active" as const,
              boundAt: now.toISOString(),
              deviceBound: Boolean(boundHash),
              sessionExpiresAt: sessionExpiresAt.toISOString(),
              reactivationConsumed,
            },
            oneTimeSecret: sessionToken,
          };
        },
      }),
    );

    return {
      status: result.replayed ? 200 : 201,
      body: {
        ...result.body,
        ...(result.oneTimeSecret ? { keySessionToken: result.oneTimeSecret } : {}),
      },
    };
  }

  private failActivation(
    tx: DbExecutor,
    actor: Actor,
    keyId: string | null,
    code: KeyDenialCode,
    reason: string,
    request: Request,
  ): never {
    return this.recordDenial(tx, actor, "key.activate_failed", keyId, code, reason, request);
  }

  async validate(input: ValidateInput): Promise<ValidationBody> {
    const actor = requireActor(input.session);
    const now = this.clock();

    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const found = await tx.query<KeyRow>(
          "select * from keys where key_hash = any($1::text[])",
          [this.keyHashCandidates(input.key)],
        );
        const row = found.rows[0];
        if (!row)
          return this.failValidation(tx, actor, null, "invalid_key", "unknown key", input.request);

        const terminal = terminalStatusDenial(row.status);
        if (terminal) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            terminal,
            `status=${row.status}`,
            input.request,
          );
        }
        if (row.status !== "active") {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "invalid_key",
            `status=${row.status}`,
            input.request,
          );
        }
        if (row.owner_discord_id !== actor.discordId) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "not_owner",
            "owner mismatch",
            input.request,
          );
        }

        const expiresAt = toDate(row.expires_at);
        if (expiresAt && expiresAt.getTime() <= now.getTime()) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "expired_key",
            "key expired",
            input.request,
          );
        }

        if (row.subscription_id) {
          const subscription = await tx.query<{ status: string; expires_at: Date | string }>(
            "select status, expires_at from subscriptions where id = $1",
            [row.subscription_id],
          );
          const current = subscription.rows[0];
          if (
            !current ||
            current.status !== "active" ||
            new Date(current.expires_at).getTime() <= now.getTime()
          ) {
            return this.failValidation(
              tx,
              actor,
              row.id,
              "expired_key",
              "subscription inactive or expired",
              input.request,
            );
          }
        }

        if (input.hwid && row.bound_hwid_hash) {
          let presented: string;
          try {
            presented = hashHwid(input.hwid, this.hwidSecret);
          } catch (error) {
            if (error instanceof HwidNormalizationError) throw badRequest("Invalid hwid");
            throw error;
          }
          if (!constantTimeEqualHex(presented, row.bound_hwid_hash)) {
            const keyId = row.id;
            const fingerprint = hwidFingerprint(presented);
            return this.failValidation(
              tx,
              actor,
              keyId,
              "hwid_mismatch",
              "hwid mismatch",
              input.request,
              [
                async (db) => {
                  await db.query(
                    `insert into key_device_history
                     (key_id, event, hwid_fingerprint, actor_user_id, ip, metadata, created_at)
                   values ($1, 'validation_failed', $2, $3, $4, $5, $6)`,
                    [
                      keyId,
                      fingerprint,
                      actor.userId,
                      clientIp(input.request),
                      JSON.stringify({ reason: "hwid_mismatch" }),
                      now.toISOString(),
                    ],
                  );
                },
              ],
            );
          }
        }

        const session = await tx.query<KeySessionRow>(
          "select * from key_sessions where session_token_hash = any($1::text[])",
          [this.sessionTokenHashCandidates(input.keySessionToken)],
        );
        const keySession = session.rows[0];
        if (
          !keySession ||
          keySession.key_id !== row.id ||
          keySession.user_id !== actor.userId ||
          keySession.revoked_at !== null
        ) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "session_required",
            "key session missing",
            input.request,
          );
        }
        if (keySession.status !== "active") {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "session_revoked",
            `session status=${keySession.status}`,
            input.request,
          );
        }
        const sessionExpiresAt = new Date(keySession.expires_at);
        if (sessionExpiresAt.getTime() <= now.getTime()) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "session_expired",
            "absolute expiry",
            input.request,
          );
        }
        const lastSeen = toDate(keySession.last_seen_at) ?? toDate(keySession.created_at);
        if (lastSeen && now.getTime() - lastSeen.getTime() > KEY_SESSION_IDLE_MS) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            "session_expired",
            "idle expiry",
            input.request,
          );
        }

        const access = await resolveScriptAccess(tx, {
          keyId: row.id,
          publicId: input.scriptId,
          now,
        });
        if (!access.ok) {
          return this.failValidation(
            tx,
            actor,
            row.id,
            access.code,
            `script access denied: ${access.code}`,
            input.request,
          );
        }
        const script = access.script;

        const dedupeSince = new Date(now.getTime() - USAGE_DEDUPE_MS);
        const recent = await tx.query<{ id: string }>(
          `select id from script_access_logs
          where key_id = $1 and script_id = $2 and actor_user_id = $3
            and result = 'granted' and created_at > $4
          order by created_at desc, id desc
          limit 1`,
          [row.id, script.scriptId, actor.userId, dedupeSince.toISOString()],
        );
        let grantId = recent.rows[0]?.id;
        if (!grantId) {
          const inserted = await tx.query<{ id: string }>(
            `insert into script_access_logs
             (script_id, version_id, actor_user_id, key_id, entitlement_id, grant_expires_at, ip, user_agent, result, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'granted', $9)
           returning id`,
            [
              script.scriptId,
              script.versionId,
              actor.userId,
              row.id,
              access.entitlementId,
              access.grantExpiresAt,
              clientIp(input.request),
              input.request.headers.get("user-agent"),
              now.toISOString(),
            ],
          );
          grantId = inserted.rows[0]!.id;
        }

        // Idle window extension. Absolute expiry never moves.
        await tx.query("update key_sessions set last_seen_at = $2 where id = $1", [
          keySession.id,
          now.toISOString(),
        ]);

        await this.audit(
          tx,
          actor.userId,
          "key.validate",
          row.id,
          {
            scriptId: script.publicId,
            grantId,
          },
          input.request,
        );

        return {
          valid: true as const,
          scriptId: script.publicId,
          keyExpiresAt: iso(row.expires_at),
          sessionExpiresAt: sessionExpiresAt.toISOString(),
          grantId,
        };
      }),
    );
  }

  private failValidation(
    tx: DbExecutor,
    actor: Actor,
    keyId: string | null,
    code: KeyDenialCode,
    reason: string,
    request: Request,
    effects: DenialEffect[] = [],
  ): never {
    return this.recordDenial(
      tx,
      actor,
      "key.validate_failed",
      keyId,
      code,
      reason,
      request,
      effects,
    );
  }

  /**
   * Owner policy: HWID reset is admin-only. Self-service is disabled, so the
   * legacy entry point fails with a stable error instead of performing a reset.
   */
  async resetHwid(_input: ResetHwidInput): Promise<ResetHwidBody> {
    throw forbidden("Self-service HWID reset is disabled. Contact an administrator.");
  }

  async listOwnKeys(session: SessionContext): Promise<Record<string, unknown>[]> {
    const actor = requireActor(session);
    const result = await this.db.query<KeyRow>(
      `select * from keys where owner_discord_id = $1 order by created_at desc, id desc`,
      [actor.discordId],
    );
    return result.rows.map((row) => this.projectKey(row));
  }

  async keyUsage(session: SessionContext, keyId: string): Promise<Record<string, unknown>> {
    const actor = requireActor(session);
    const key = await this.db.query<KeyRow>("select * from keys where id = $1", [keyId]);
    const row = key.rows[0];
    if (!row) throw notFound("Key not found");
    if (row.owner_discord_id !== actor.discordId) throw keyDenied("not_owner");

    const usage = await this.db.query<{
      total: number;
      last_access_at: Date | string | null;
      scripts: number;
    }>(
      `select count(*)::int as total,
              max(created_at) as last_access_at,
              count(distinct script_id)::int as scripts
         from script_access_logs
        where key_id = $1 and result = 'granted'`,
      [keyId],
    );
    const stats = usage.rows[0]!;
    return {
      keyId,
      totalGrants: stats.total,
      distinctScripts: stats.scripts,
      lastAccessAt: iso(stats.last_access_at),
    };
  }

  async keyDevices(session: SessionContext, keyId: string): Promise<Record<string, unknown>[]> {
    const actor = requireActor(session);
    const key = await this.db.query<KeyRow>("select * from keys where id = $1", [keyId]);
    const row = key.rows[0];
    if (!row) throw notFound("Key not found");
    if (row.owner_discord_id !== actor.discordId) throw keyDenied("not_owner");
    return this.deviceHistory(this.db, keyId);
  }

  async adminListKeys(input: AdminListKeysInput): Promise<Record<string, unknown>[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.status) {
      params.push(input.status);
      clauses.push(`status = $${params.length}`);
    }
    if (input.type) {
      params.push(input.type);
      clauses.push(`type = $${params.length}`);
    }
    if (input.ownerDiscordId) {
      params.push(input.ownerDiscordId);
      clauses.push(`owner_discord_id = $${params.length}`);
    }
    params.push(input.limit);
    const limitPosition = params.length;
    params.push(input.offset);
    const offsetPosition = params.length;

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const result = await this.db.query<KeyRow>(
      `select * from keys
       ${where}
       order by created_at desc, id desc
       limit $${limitPosition} offset $${offsetPosition}`,
      params,
    );
    return result.rows.map((row) => this.projectKey(row));
  }

  async adminRevoke(input: AdminRevokeInput): Promise<Record<string, unknown>> {
    const actor = requireActor(input.session);
    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const now = this.clock();
        const found = await tx.query<KeyRow>("select * from keys where id = $1 for update", [
          input.keyId,
        ]);
        const row = found.rows[0];
        if (!row) throw notFound("Key not found");
        if (row.status === "banned") {
          return this.failRevoke(tx, actor, row.id, "banned_key", "banned key", input.request);
        }
        if (row.status === "revoked") {
          return { keyId: row.id, status: "revoked", alreadyRevoked: true };
        }

        await tx.query("update keys set status = 'revoked', updated_at = $2 where id = $1", [
          row.id,
          now.toISOString(),
        ]);
        const revokedSessions = await this.revokeKeySessions(tx, row.id, now);
        await tx.query(
          `insert into key_device_history
           (key_id, event, hwid_fingerprint, actor_admin_id, ip, metadata, created_at)
         values ($1, 'revoked', $2, $3, $4, $5, $6)`,
          [
            row.id,
            row.bound_hwid_hash ? hwidFingerprint(row.bound_hwid_hash) : null,
            actor.userId,
            clientIp(input.request),
            JSON.stringify({ reason: input.reason ?? null, revokedSessions }),
            now.toISOString(),
          ],
        );
        await this.audit(
          tx,
          actor.userId,
          "key.revoke",
          row.id,
          {
            reason: input.reason ?? null,
            revokedSessions,
          },
          input.request,
        );
        return { keyId: row.id, status: "revoked", revokedSessions };
      }),
    );
  }

  private failRevoke(
    tx: DbExecutor,
    actor: Actor,
    keyId: string,
    code: KeyDenialCode,
    reason: string,
    request: Request,
  ): never {
    return this.recordDenial(tx, actor, "key.revoke_failed", keyId, code, reason, request);
  }

  async adminResetHwid(input: AdminResetHwidInput): Promise<Record<string, unknown>> {
    const actor = requireActor(input.session);
    return this.persistDenial(() =>
      this.db.transaction(async (tx) => {
        const now = this.clock();
        const found = await tx.query<KeyRow>("select * from keys where id = $1 for update", [
          input.keyId,
        ]);
        const row = found.rows[0];
        if (!row) throw notFound("Key not found");
        if (row.status === "banned") {
          return this.failAdminReset(tx, actor, row.id, "banned_key", "banned key", input.request);
        }
        if (row.status !== "active") {
          return this.failAdminReset(
            tx,
            actor,
            row.id,
            "key_not_active",
            `status=${row.status}`,
            input.request,
          );
        }

        const previousFingerprint = row.bound_hwid_hash
          ? hwidFingerprint(row.bound_hwid_hash)
          : null;
        await tx.query(
          `update keys
            set bound_hwid_hash = null,
                hwid_bound_at = null,
                last_hwid_reset_at = $2,
                hwid_reset_count = hwid_reset_count + 1,
                updated_at = $2
          where id = $1`,
          [row.id, now.toISOString()],
        );
        const revokedSessions = await this.revokeKeySessions(tx, row.id, now);
        await tx.query(
          `insert into key_hwid_resets
           (key_id, user_id, performed_by, admin_id, previous_hwid_fingerprint, reason, created_at)
         values ($1, $2, 'admin', $3, $4, $5, $6)`,
          [row.id, row.user_id, actor.userId, previousFingerprint, input.reason, now.toISOString()],
        );
        await tx.query(
          `insert into key_device_history
           (key_id, event, hwid_fingerprint, actor_admin_id, ip, metadata, created_at)
         values ($1, 'reset_admin', $2, $3, $4, $5, $6)`,
          [
            row.id,
            previousFingerprint,
            actor.userId,
            clientIp(input.request),
            JSON.stringify({ reason: input.reason, revokedSessions }),
            now.toISOString(),
          ],
        );
        await this.audit(
          tx,
          actor.userId,
          "key.hwid_reset_admin",
          row.id,
          {
            reason: input.reason,
            revokedSessions,
          },
          input.request,
        );
        return { resetAt: now.toISOString(), performedBy: "admin" };
      }),
    );
  }

  private failAdminReset(
    tx: DbExecutor,
    actor: Actor,
    keyId: string,
    code: KeyDenialCode,
    reason: string,
    request: Request,
  ): never {
    return this.recordDenial(
      tx,
      actor,
      "key.hwid_reset_admin_failed",
      keyId,
      code,
      reason,
      request,
    );
  }

  async adminDevices(_session: SessionContext, keyId: string): Promise<Record<string, unknown>[]> {
    const key = await this.db.query<KeyRow>("select * from keys where id = $1", [keyId]);
    if (!key.rows[0]) throw notFound("Key not found");
    return this.deviceHistory(this.db, keyId);
  }

  private async revokeKeySessions(tx: DbExecutor, keyId: string, now: Date): Promise<number> {
    const web = await tx.query(
      `update key_sessions
          set status = 'revoked', revoked_at = $2
        where key_id = $1 and status = 'active'`,
      [keyId, now.toISOString()],
    );
    // Executor sessions are independent of web sessions, so license revocation
    // and admin HWID resets have to close both.
    const executor = await tx.query(
      `update executor_sessions
          set status = 'revoked', revoked_at = $2
        where key_id = $1 and status = 'active'`,
      [keyId, now.toISOString()],
    );
    return (web.rowCount ?? 0) + (executor.rowCount ?? 0);
  }

  private async deviceHistory(db: DbExecutor, keyId: string): Promise<Record<string, unknown>[]> {
    const result = await db.query<{
      event: string;
      hwid_fingerprint: string | null;
      created_at: Date | string;
      actor_user_id: string | null;
      actor_admin_id: string | null;
    }>(
      `select event, hwid_fingerprint, created_at, actor_user_id, actor_admin_id
         from key_device_history
        where key_id = $1
        order by created_at desc, id desc`,
      [keyId],
    );
    return result.rows.map((row) => ({
      event: row.event,
      hwidFingerprint: row.hwid_fingerprint,
      createdAt: iso(row.created_at),
      actor: row.actor_admin_id ? "admin" : row.actor_user_id ? "user" : "system",
    }));
  }

  private projectKey(row: KeyRow): Record<string, unknown> {
    return {
      keyId: row.id,
      keyPrefix: row.key_prefix,
      type: row.type,
      status: row.status,
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
      deviceBound: row.bound_hwid_hash !== null,
      hwidBoundAt: iso(row.hwid_bound_at),
      hwidResetCount: row.hwid_reset_count,
      ban:
        row.status === "banned"
          ? {
              bannedAt: iso(row.banned_at),
              reason: row.ban_reason,
            }
          : null,
    };
  }
}

export function createKeyService(deps: KeyServiceDeps = {}): KeyService {
  return new PostgresKeyService(deps);
}
