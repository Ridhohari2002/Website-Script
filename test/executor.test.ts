import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { AppError } from "@/core/errors";
import { hashHwid } from "@/core/crypto/hwid";
import {
  createKeyHarness,
  entitleKey,
  legacyKeyService,
  requestFor,
  seedScript,
  sessionFor,
  TEST_HWID_SECRET,
  type KeyHarness,
} from "./helpers/keys";
import { trustedProxyHeaders } from "./helpers/proxy";

afterAll(() => resetEnvCache());

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected the operation to fail");
}

async function setup(harness: KeyHarness, publicId = "script-one") {
  await seedScript(harness.db, { publicId });
  const generated = await harness.service.generateKeys({
    session: sessionFor(harness.owner),
    request: requestFor(),
    count: 1,
    type: "paid",
    maxActivations: 1,
  });
  await entitleKey(harness.db, generated[0]!.keyId);
  return generated[0]!;
}

/**
 * Creates a Phase 4 Discord-claimed key: active, owned by the buyer, with a
 * `discord` claim kind and optional HWID binding. This is the shape the
 * executor must not silently re-claim.
 */
async function setupLegacyClaim(
  harness: KeyHarness,
  options: { hwid?: string } = {},
): Promise<{ keyId: string; key: string; ownerDiscordId: string }> {
  await seedScript(harness.db, { publicId: "script-one" });
  const legacy = legacyKeyService(harness.db, harness.clock.now);
  const generated = await legacy.generateKeys({
    session: sessionFor(harness.owner),
    request: requestFor(),
    count: 1,
    type: "paid",
    maxActivations: 1,
  });
  const key = generated[0]!;
  await entitleKey(harness.db, key.keyId);
  const boundHash = options.hwid ? hashHwid(options.hwid, TEST_HWID_SECRET) : null;
  // Phase 4 claim shape: owner identity, discord claim kind, and optionally a
  // device binding. This is written directly so the fixture is independent of
  // web-activation policy changes.
  await harness.db.query(
    `update keys
        set status = 'active',
            owner_discord_id = $2,
            user_id = $3,
            bound_hwid_hash = $4,
            hwid_bound_at = case when $4::text is null then null else $5::timestamptz end,
            claimed_at = $5::timestamptz,
            claim_kind = 'discord',
            claim_ref = $2,
            activation_count = 1
      where id = $1`,
    [
      key.keyId,
      harness.owner.discordId,
      harness.owner.userId,
      boundHash,
      harness.clock.now().toISOString(),
    ],
  );
  return {
    keyId: key.keyId,
    key: key.key,
    ownerDiscordId: harness.owner.discordId,
  };
}

function executorRequest(): Request {
  return new Request("http://localhost:3000/api/executor/v1/activate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...trustedProxyHeaders("198.51.100.7"),
      "user-agent": "executor-test",
    },
  });
}

async function activate(
  harness: KeyHarness,
  key: string,
  options: {
    hwid?: string;
    scriptId?: string;
    robloxUsername?: string;
    robloxUserId?: string;
  } = {},
) {
  return harness.executor.activate({
    request: executorRequest(),
    key,
    hwid: options.hwid ?? "abcdef123456",
    scriptId: options.scriptId ?? "script-one",
    clientVersion: "1.0.0",
    ...(options.robloxUsername ? { robloxUsername: options.robloxUsername } : {}),
    ...(options.robloxUserId ? { robloxUserId: options.robloxUserId } : {}),
    executorName: "TestExecutor",
    executorVersion: "9.9",
  });
}

async function validate(
  harness: KeyHarness,
  sessionToken: string,
  options: {
    hwid?: string;
    scriptId?: string;
    timestamp?: string | number;
    nonce?: string;
  } = {},
) {
  return harness.executor.validate({
    request: executorRequest(),
    sessionToken,
    scriptId: options.scriptId ?? "script-one",
    hwid: options.hwid ?? "abcdef123456",
    timestamp: options.timestamp ?? harness.clock.now().toISOString(),
    nonce: options.nonce ?? randomUUID(),
    clientVersion: "1.0.0",
  });
}

describe("executor activation", () => {
  it("activates with only a key and binds the first device without Discord", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const result = await activate(harness, generated.key, {
        robloxUserId: "123456789",
        robloxUsername: "BuyerAlt",
      });

      expect(result.status).toBe("active");
      expect(result.firstClaim).toBe(true);
      expect(result.reactivated).toBe(false);
      expect(result.activationCount).toBe(1);
      expect(result.sessionToken).toHaveLength(43);
      expect(JSON.stringify(result)).not.toContain(generated.key);
      expect(JSON.stringify(result)).not.toContain("abcdef123456");

      const key = await harness.db.query<{
        status: string;
        bound_hwid_hash: string | null;
        claim_kind: string;
        activation_count: number;
        key_hash_version: string;
      }>(
        "select status, bound_hwid_hash, claim_kind, activation_count, key_hash_version from keys where id = $1",
        [generated.keyId],
      );
      expect(key.rows[0]).toMatchObject({
        status: "active",
        claim_kind: "executor",
        activation_count: 1,
        key_hash_version: "v2",
      });
      expect(key.rows[0]!.bound_hwid_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(key.rows[0]!.bound_hwid_hash).not.toBe("abcdef123456");
    } finally {
      await harness.close();
    }
  });

  it("reactivates with the same key and HWID without consuming an activation", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const first = await activate(harness, generated.key);
      const second = await activate(harness, generated.key);

      expect(second.reactivated).toBe(true);
      expect(second.firstClaim).toBe(false);
      expect(second.activationCount).toBe(1);
      expect(second.sessionToken).not.toBe(first.sessionToken);

      const row = await harness.db.query<{ activation_count: number }>(
        "select activation_count from keys where id = $1",
        [generated.keyId],
      );
      expect(row.rows[0]!.activation_count).toBe(1);

      const sessions = await harness.db.query<{ status: string; count: number }>(
        `select status, count(*)::int as count
           from executor_sessions where key_id = $1 group by status`,
        [generated.keyId],
      );
      const byStatus = Object.fromEntries(sessions.rows.map((row) => [row.status, row.count]));
      expect(byStatus.active).toBe(1);
      expect(byStatus.superseded).toBe(1);

      expect(await errorCode(validate(harness, first.sessionToken))).toBe("session_revoked");
    } finally {
      await harness.close();
    }
  });

  it("rejects an activation from a different HWID", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      await activate(harness, generated.key);
      expect(await errorCode(activate(harness, generated.key, { hwid: "999999999999" }))).toBe(
        "hwid_mismatch",
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps one active session when two activations race", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const results = await Promise.allSettled([
        activate(harness, generated.key, { hwid: "abcdef123456" }),
        activate(harness, generated.key, { hwid: "abcdef123456" }),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);

      const active = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from executor_sessions where key_id = $1 and status = 'active'",
        [generated.keyId],
      );
      expect(active.rows[0]!.count).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("lets only one of two different-device activations bind", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const results = await Promise.allSettled([
        activate(harness, generated.key, { hwid: "abcdef123456" }),
        activate(harness, generated.key, { hwid: "111111111111" }),
      ]);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as AppError).code).toBe("hwid_mismatch");
    } finally {
      await harness.close();
    }
  });
});

describe("executor validation", () => {
  it("grants an entitled script and consumes a nonce", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      const nonce = randomUUID();

      const result = await validate(harness, activation.sessionToken, { nonce });
      expect(result.valid).toBe(true);
      expect(result.scriptId).toBe("script-one");
      expect(result.grantId).toBeTruthy();

      const logs = await harness.db.query<{ result: string; executor_session_id: string }>(
        "select result, executor_session_id from script_access_logs",
      );
      expect(logs.rows[0]).toMatchObject({
        result: "granted",
        executor_session_id: activation.sessionId,
      });

      expect(await errorCode(validate(harness, activation.sessionToken, { nonce }))).toBe(
        "replay_detected",
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown session token", async () => {
    const harness = await createKeyHarness();
    try {
      await setup(harness);
      expect(await errorCode(validate(harness, "definitely-not-a-token"))).toBe("session_required");
    } finally {
      await harness.close();
    }
  });

  it("rejects a stale timestamp and a future timestamp", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      const now = harness.clock.now().getTime();

      expect(
        await errorCode(
          validate(harness, activation.sessionToken, {
            timestamp: new Date(now - 10 * 60 * 1000).toISOString(),
          }),
        ),
      ).toBe("timestamp_invalid");
      expect(
        await errorCode(
          validate(harness, activation.sessionToken, {
            timestamp: new Date(now + 10 * 60 * 1000).toISOString(),
          }),
        ),
      ).toBe("timestamp_invalid");
    } finally {
      await harness.close();
    }
  });

  it("expires an idle session after 30 minutes", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      harness.clock.advance(31 * 60 * 1000);
      expect(await errorCode(validate(harness, activation.sessionToken))).toBe("session_expired");

      const session = await harness.db.query<{ status: string }>(
        "select status from executor_sessions where id = $1",
        [activation.sessionId],
      );
      expect(session.rows[0]!.status).toBe("expired");
    } finally {
      await harness.close();
    }
  });

  it("enforces the 24-hour absolute lifetime even with recent activity", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      harness.clock.advance(24 * 60 * 60 * 1000 + 1000);
      // Keep the idle window artificially open so only absolute expiry applies.
      await harness.db.query("update executor_sessions set idle_expires_at = $2 where id = $1", [
        activation.sessionId,
        new Date(harness.clock.now().getTime() + 60_000).toISOString(),
      ]);
      expect(await errorCode(validate(harness, activation.sessionToken))).toBe("session_expired");
    } finally {
      await harness.close();
    }
  });

  it("rejects a mismatched HWID during validation", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      expect(
        await errorCode(validate(harness, activation.sessionToken, { hwid: "999999999999" })),
      ).toBe("hwid_mismatch");

      const history = await harness.db.query<{ event: string }>(
        "select event from key_device_history where key_id = $1",
        [generated.keyId],
      );
      expect(history.rows.map((row) => row.event)).toContain("executor_validation_failed");
    } finally {
      await harness.close();
    }
  });

  it("denies a script outside the product entitlement", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      await seedScript(harness.db, { publicId: "script-two" });
      const activation = await activate(harness, generated.key);
      expect(
        await errorCode(validate(harness, activation.sessionToken, { scriptId: "script-two" })),
      ).toBe("entitlement_missing");
    } finally {
      await harness.close();
    }
  });

  it("denies a suspended entitlement", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);
      await harness.db.query("update key_entitlements set status = 'suspended' where key_id = $1", [
        generated.keyId,
      ]);
      expect(await errorCode(validate(harness, activation.sessionToken))).toBe(
        "entitlement_suspended",
      );
    } finally {
      await harness.close();
    }
  });

  it("denies an unpublished, disabled, or deleted script", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);

      for (const change of [
        "update scripts set enabled = false where public_id = 'script-one'",
        "update scripts set deleted_at = now() where public_id = 'script-one'",
        "update scripts set status = 'draft' where public_id = 'script-one'",
      ]) {
        await harness.db.query(change);
        expect(await errorCode(validate(harness, activation.sessionToken))).toBe(
          "script_not_found",
        );
      }
    } finally {
      await harness.close();
    }
  });
});

describe("executor revocation", () => {
  it("revokes only the calling session and reports a stable idempotent outcome", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const newSession = await activate(harness, generated.key);
      const oldSession = await activate(harness, generated.key);

      const revoked = await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: oldSession.sessionToken,
      });
      expect(revoked).toMatchObject({
        revoked: true,
        alreadyRevoked: false,
        outcome: "revoked",
        status: "revoked",
      });

      const again = await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: oldSession.sessionToken,
      });
      expect(again).toMatchObject({
        revoked: false,
        alreadyRevoked: true,
        outcome: "already_revoked",
        status: "revoked",
      });

      const audit = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from audit_logs where action = 'executor.session_revoke' and target_id = $1",
        [generated.keyId],
      );
      expect(audit.rows[0]!.count).toBe(1);

      expect(await errorCode(validate(harness, oldSession.sessionToken))).toBe("session_revoked");

      const key = await harness.db.query<{ status: string; owner_discord_id: string | null }>(
        "select status, owner_discord_id from keys where id = $1",
        [generated.keyId],
      );
      expect(key.rows[0]!.status).toBe("active");
      expect(key.rows[0]!.owner_discord_id).toBeNull();

      // The other session is not the caller; revoking one session must never
      // touch it. It is already superseded by the newer activation.
      const other = await harness.db.query<{ status: string }>(
        "select status from executor_sessions where id = $1",
        [newSession.sessionId],
      );
      expect(other.rows[0]!.status).toBe("superseded");
    } finally {
      await harness.close();
    }
  });

  it("does not report a new revocation for a superseded session", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const superseded = await activate(harness, generated.key);
      const active = await activate(harness, generated.key);

      const result = await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: superseded.sessionToken,
      });
      expect(result).toMatchObject({
        sessionId: superseded.sessionId,
        revoked: false,
        alreadyRevoked: false,
        outcome: "superseded",
        status: "superseded",
      });

      const audit = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from audit_logs where action = 'executor.session_revoke' and target_id = $1",
        [generated.keyId],
      );
      expect(audit.rows[0]!.count).toBe(0);

      // The active session is unaffected and still validates.
      const valid = await validate(harness, active.sessionToken);
      expect(valid.valid).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("keeps another key's active session active", async () => {
    const harness = await createKeyHarness();
    try {
      const first = await setup(harness);
      const second = await setup(harness, "script-two");
      const firstSession = await activate(harness, first.key);
      const secondSession = await activate(harness, second.key, { scriptId: "script-two" });

      await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: firstSession.sessionToken,
      });

      const secondRow = await harness.db.query<{ status: string }>(
        "select status from executor_sessions where id = $1",
        [secondSession.sessionId],
      );
      expect(secondRow.rows[0]!.status).toBe("active");
      const valid = await validate(harness, secondSession.sessionToken, { scriptId: "script-two" });
      expect(valid.valid).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe("executor rate limits", () => {
  it("uses the server-side key id for the activation bucket", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      harness.limiter.allowed = false;

      expect(await errorCode(activate(harness, generated.key))).toBe("rate_limited");
      const keyCall = harness.limiter.calls.at(-1)!;
      expect(keyCall).toHaveLength(1);
      expect(keyCall[0]).toMatchObject({ kind: "key", value: generated.keyId });
      expect(JSON.stringify(harness.limiter.calls)).not.toContain(generated.key);
    } finally {
      await harness.close();
    }
  });

  it("uses the server-side session id for validation and revocation buckets", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const activation = await activate(harness, generated.key);

      harness.limiter.allowed = false;
      expect(await errorCode(validate(harness, activation.sessionToken))).toBe("rate_limited");
      expect(harness.limiter.calls.at(-1)![0]).toMatchObject({
        kind: "key",
        value: activation.sessionId,
      });

      expect(
        await errorCode(
          harness.executor.revokeSession({
            request: executorRequest(),
            sessionToken: activation.sessionToken,
          }),
        ),
      ).toBe("rate_limited");
      expect(harness.limiter.calls.at(-1)![0]).toMatchObject({
        kind: "key",
        value: activation.sessionId,
      });
    } finally {
      await harness.close();
    }
  });
});

describe("legacy claim safety", () => {
  it("rejects a Discord-claimed key with no HWID until an admin authorizes migration", async () => {
    const harness = await createKeyHarness();
    try {
      const legacy = await setupLegacyClaim(harness);

      // Clear the HWID to recreate the ambiguous legacy shape: Discord-claimed
      // but with no device binding.
      await harness.db.query(
        "update keys set bound_hwid_hash = null, hwid_bound_at = null where id = $1",
        [legacy.keyId],
      );

      expect(await errorCode(activate(harness, legacy.key))).toBe("already_owned");

      const unchanged = await harness.db.query<{
        claim_kind: string;
        owner_discord_id: string | null;
        activation_count: number;
        bound_hwid_hash: string | null;
      }>(
        "select claim_kind, owner_discord_id, activation_count, bound_hwid_hash from keys where id = $1",
        [legacy.keyId],
      );
      expect(unchanged.rows[0]).toMatchObject({
        claim_kind: "discord",
        owner_discord_id: legacy.ownerDiscordId,
        activation_count: 1,
        bound_hwid_hash: null,
      });

      const sessions = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from executor_sessions where key_id = $1",
        [legacy.keyId],
      );
      expect(sessions.rows[0]!.count).toBe(0);

      const authorization = await harness.service.adminAuthorizeExecutorClaim({
        session: sessionFor(harness.owner),
        request: requestFor(),
        keyId: legacy.keyId,
        reason: "verified purchase support migration",
      });
      expect(authorization.alreadyAuthorized).toBe(false);

      const activated = await activate(harness, legacy.key);
      expect(activated.firstClaim).toBe(false);
      expect(activated.activationCount).toBe(1);

      const migrated = await harness.db.query<{
        claim_kind: string;
        owner_discord_id: string | null;
        activation_count: number;
        bound_hwid_hash: string | null;
      }>(
        "select claim_kind, owner_discord_id, activation_count, bound_hwid_hash from keys where id = $1",
        [legacy.keyId],
      );
      expect(migrated.rows[0]!.claim_kind).toBe("executor");
      expect(migrated.rows[0]!.owner_discord_id).toBe(legacy.ownerDiscordId);
      expect(migrated.rows[0]!.activation_count).toBe(1);
      expect(migrated.rows[0]!.bound_hwid_hash).toMatch(/^[0-9a-f]{64}$/);

      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where target_id = $1 and action = 'key.executor_claim_authorize'",
        [legacy.keyId],
      );
      expect(audit.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("allows same-HWID recovery for a legacy key without consuming an activation", async () => {
    const harness = await createKeyHarness();
    try {
      const legacy = await setupLegacyClaim(harness, { hwid: "abcdef123456" });
      const result = await activate(harness, legacy.key);

      expect(result.firstClaim).toBe(false);
      expect(result.reactivated).toBe(true);
      expect(result.activationCount).toBe(1);

      const row = await harness.db.query<{
        claim_kind: string;
        owner_discord_id: string | null;
        activation_count: number;
      }>("select claim_kind, owner_discord_id, activation_count from keys where id = $1", [
        legacy.keyId,
      ]);
      expect(row.rows[0]).toMatchObject({
        claim_kind: "discord",
        owner_discord_id: legacy.ownerDiscordId,
        activation_count: 1,
      });
    } finally {
      await harness.close();
    }
  });

  it("does not consume another activation when a successful activation is retried", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const first = await activate(harness, generated.key);
      const retried = await activate(harness, generated.key);

      expect(first.firstClaim).toBe(true);
      expect(first.activationCount).toBe(1);
      expect(retried.firstClaim).toBe(false);
      expect(retried.reactivated).toBe(true);
      expect(retried.activationCount).toBe(1);

      const row = await harness.db.query<{ activation_count: number }>(
        "select activation_count from keys where id = $1",
        [generated.keyId],
      );
      expect(row.rows[0]!.activation_count).toBe(1);
    } finally {
      await harness.close();
    }
  });
});

describe("buyer identity separation", () => {
  it("does not change the buyer record when another person uses the key", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const product = await harness.db.query<{ id: string }>(
        "select id from products where code = $1",
        ["product:script-one"],
      );
      await harness.db.query(
        `insert into key_purchases
           (key_id, buyer_discord_id, buyer_discord_username, product_id, payment_status, source)
         values ($1, $2, $3, $4, 'paid', 'purchase')`,
        [generated.keyId, harness.owner.discordId, "Buyer", product.rows[0]!.id],
      );

      await activate(harness, generated.key, {
        robloxUserId: "999888777",
        robloxUsername: "SomeoneElse",
      });

      const buyer = await harness.db.query<{
        buyer_discord_id: string;
        buyer_discord_username: string;
        payment_status: string;
      }>(
        "select buyer_discord_id, buyer_discord_username, payment_status from key_purchases where key_id = $1",
        [generated.keyId],
      );
      expect(buyer.rows[0]).toEqual({
        buyer_discord_id: harness.owner.discordId,
        buyer_discord_username: "Buyer",
        payment_status: "paid",
      });

      const executor = await harness.db.query<{ roblox_username: string }>(
        "select roblox_username from executor_sessions where key_id = $1",
        [generated.keyId],
      );
      expect(executor.rows[0]!.roblox_username).toBe("SomeoneElse");
    } finally {
      await harness.close();
    }
  });
});

describe("legacy mapping", () => {
  it("denies legacy keys until an explicit product-script mapping exists", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const legacy = await harness.db.query<{ id: string }>(
        "insert into products (code, name) values ('legacy-test', 'Legacy test') returning id",
      );
      const generated = await harness.service.generateKeys({
        session: {
          userId: harness.owner.userId,
          roles: harness.owner.roles,
          user: {
            id: harness.owner.userId,
            discordId: harness.owner.discordId,
            username: harness.owner.username,
            avatarUrl: null,
          },
        },
        request: requestFor(),
        count: 1,
        type: "paid",
        maxActivations: 1,
      });
      await harness.db.query(
        `insert into key_entitlements (key_id, product_id, source, status, starts_at)
         values ($1, $2, 'legacy', 'active', '2020-01-01T00:00:00.000Z')`,
        [generated[0]!.keyId, legacy.rows[0]!.id],
      );

      expect(await errorCode(activate(harness, generated[0]!.key))).toBe("entitlement_missing");

      const script = await harness.db.query<{ id: string }>(
        "select id from scripts where public_id = 'script-one'",
      );
      await harness.db.query(
        "insert into product_scripts (product_id, script_id) values ($1, $2)",
        [legacy.rows[0]!.id, script.rows[0]!.id],
      );
      const result = await activate(harness, generated[0]!.key);
      expect(result.status).toBe("active");
    } finally {
      await harness.close();
    }
  });
});

describe("denial durability", () => {
  it("persists a denial audit after the main transaction rolls back", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      await activate(harness, generated.key);
      await errorCode(activate(harness, generated.key, { hwid: "999999999999" }));

      const audit = await harness.db.query<{ action: string; actor_type: string }>(
        "select action, actor_type from audit_logs where target_id = $1 and action = 'executor.activate_failed'",
        [generated.keyId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.actor_type).toBe("executor");

      const sessions = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from executor_sessions where key_id = $1",
        [generated.keyId],
      );
      expect(sessions.rows[0]!.count).toBe(1);
    } finally {
      await harness.close();
    }
  });
});
