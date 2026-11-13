import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { AppError } from "@/core/errors";
import {
  createKeyHarness,
  entitleKey,
  requestFor,
  seedScript,
  type KeyHarness,
} from "./helpers/keys";

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
  await entitleKey(harness.db, generated[0]!.keyId);
  return generated[0]!;
}

function executorRequest(): Request {
  return new Request("http://localhost:3000/api/executor/v1/activate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.7",
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
      }>("select status, bound_hwid_hash, claim_kind, activation_count from keys where id = $1", [
        generated.keyId,
      ]);
      expect(key.rows[0]).toMatchObject({
        status: "active",
        claim_kind: "executor",
        activation_count: 1,
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
  it("revokes only the calling session and is idempotent", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await setup(harness);
      const newSession = await activate(harness, generated.key);
      const oldSession = await activate(harness, generated.key);

      const revoked = await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: oldSession.sessionToken,
      });
      expect(revoked).toMatchObject({ revoked: true, alreadyRevoked: false });

      const again = await harness.executor.revokeSession({
        request: executorRequest(),
        sessionToken: oldSession.sessionToken,
      });
      expect(again).toMatchObject({ revoked: false, alreadyRevoked: true });

      expect(await errorCode(validate(harness, oldSession.sessionToken))).toBe("session_revoked");
      expect(await errorCode(validate(harness, newSession.sessionToken))).toBe("session_revoked");

      const key = await harness.db.query<{ status: string; owner_discord_id: string | null }>(
        "select status, owner_discord_id from keys where id = $1",
        [generated.keyId],
      );
      expect(key.rows[0]!.status).toBe("active");
      expect(key.rows[0]!.owner_discord_id).toBeNull();
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
