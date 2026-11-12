import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { AppError } from "@/core/errors";
import {
  createKeyHarness,
  requestFor,
  seedScript,
  sessionFor,
  type KeyHarness,
  type TestUser,
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

async function generate(
  harness: KeyHarness,
  options: { maxActivations?: number; expiresAt?: string | null; type?: "free" | "paid" } = {},
) {
  const generated = await harness.service.generateKeys({
    session: sessionFor(harness.owner),
    request: requestFor(),
    count: 1,
    type: options.type ?? "paid",
    maxActivations: options.maxActivations ?? 1,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  });
  return generated[0]!;
}

async function activate(
  harness: KeyHarness,
  key: string,
  options: { user?: TestUser; hwid?: string } = {},
) {
  return harness.service.activate({
    session: sessionFor(options.user ?? harness.owner),
    request: requestFor(),
    key,
    ...(options.hwid ? { hwid: options.hwid } : {}),
    idempotencyKey: randomUUID(),
  });
}

function ownerSession(harness: KeyHarness) {
  return sessionFor(harness.owner);
}

describe("key generation", () => {
  it("stores only hashes and returns plaintext once", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      const stored = await harness.db.query<{ key_hash: string; key_prefix: string }>(
        "select key_hash, key_prefix from keys where id = $1",
        [generated.keyId],
      );
      expect(stored.rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows[0]!.key_hash).not.toContain(generated.key);
      expect(stored.rows[0]!.key_prefix).toBe(generated.keyPrefix);

      const audit = await harness.db.query<{ action: string }>(
        "select action from audit_logs where target_id = $1",
        [generated.keyId],
      );
      expect(audit.rows.map((row) => row.action)).toContain("key.generate");
    } finally {
      await harness.close();
    }
  });
});

describe("activation", () => {
  it("claims an unused key, binds a device, and issues one key session", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key, { hwid: "AB-CD-EF-12-34-56" });
      expect(activated.status).toBe(201);
      expect(activated.body.status).toBe("active");
      expect(activated.body.deviceBound).toBe(true);
      expect(activated.body.keySessionToken).toBeTruthy();
      expect(JSON.stringify(activated.body)).not.toContain("AB-CD-EF");

      const sessions = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from key_sessions where key_id = $1 and status = 'active'",
        [generated.keyId],
      );
      expect(sessions.rows[0]!.count).toBe(1);

      const devices = await harness.service.keyDevices(ownerSession(harness), generated.keyId);
      expect(devices).toHaveLength(1);
      expect(devices[0]!.event).toBe("bound");
      expect(String(devices[0]!.hwidFingerprint)).toHaveLength(12);
      expect(JSON.stringify(devices)).not.toContain("abcdef123456");
    } finally {
      await harness.close();
    }
  });

  it("replays an idempotent activation without returning the token again", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      const idempotencyKey = randomUUID();
      const input = {
        session: ownerSession(harness),
        request: requestFor(),
        key: generated.key,
        hwid: "abcdef123456",
        idempotencyKey,
      };
      const first = await harness.service.activate(input);
      const replay = await harness.service.activate(input);
      expect(first.status).toBe(201);
      expect(first.body.keySessionToken).toBeTruthy();
      expect(replay.status).toBe(200);
      expect(replay.body.keySessionToken).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("rejects a key owned by another account", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      await activate(harness, generated.key);
      expect(
        await errorCode(
          activate(harness, generated.key, { user: harness.other, hwid: "abcdef123456" }),
        ),
      ).toBe("already_owned");
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired key", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness, { expiresAt: "2025-12-31T00:00:00.000Z" });
      expect(await errorCode(activate(harness, generated.key))).toBe("expired_key");
    } finally {
      await harness.close();
    }
  });
});

describe("validation", () => {
  it("grants a published script and writes an access log", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key, { hwid: "abcdef123456" });

      const result = await harness.service.validate({
        session: ownerSession(harness),
        request: requestFor(),
        key: generated.key,
        scriptId: "script-one",
        hwid: "ab-cd-ef-12-34-56",
        keySessionToken: activated.body.keySessionToken!,
      });
      expect(result.valid).toBe(true);
      expect(result.scriptId).toBe("script-one");
      expect(result.grantId).toBeTruthy();

      const logs = await harness.db.query<{ result: string; key_id: string }>(
        "select result, key_id from script_access_logs",
      );
      expect(logs.rows).toEqual([{ result: "granted", key_id: generated.keyId }]);
    } finally {
      await harness.close();
    }
  });

  it("denies a mismatched HWID and records the failure", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key, { hwid: "abcdef123456" });

      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "script-one",
            hwid: "999999999999",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("hwid_mismatch");

      const history = await harness.db.query<{ event: string }>(
        "select event from key_device_history where key_id = $1",
        [generated.keyId],
      );
      expect(history.rows.map((row) => row.event)).toContain("validation_failed");
    } finally {
      await harness.close();
    }
  });

  it("rejects an expired key session", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key);
      harness.clock.advance(31 * 60 * 1000);

      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "script-one",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("session_expired");
    } finally {
      await harness.close();
    }
  });

  it("rejects an unpublished script", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "draft-one", status: "draft" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key);
      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "draft-one",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("not_authorized");
    } finally {
      await harness.close();
    }
  });
});

describe("terminal status gates", () => {
  it("denies activation, validation, and reset for a banned key", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key);
      await harness.db.query(
        "update keys set status = 'banned', banned_at = now(), ban_reason = 'test' where id = $1",
        [generated.keyId],
      );

      expect(await errorCode(activate(harness, generated.key))).toBe("banned_key");
      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "anything",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("banned_key");
      expect(
        await errorCode(
          harness.service.resetHwid({
            session: ownerSession(harness),
            request: requestFor(),
            keyId: generated.keyId,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).toBe("banned_key");
    } finally {
      await harness.close();
    }
  });
});

describe("suspended keys and reactivation authorization", () => {
  it("requires an unused authorization and consumes it exactly once", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness, { maxActivations: 5 });
      await activate(harness, generated.key, { hwid: "abcdef123456" });
      await harness.db.query("update keys set status = 'suspended' where id = $1", [
        generated.keyId,
      ]);

      const ban = await harness.db.query<{ id: string }>(
        `insert into key_bans
           (key_id, reason, detected_at, banned_at, detection_category, confidence, review_status)
         values ($1, 'test', now(), now(), 'other', 'confirmed', 'confirmed')
         returning id`,
        [generated.keyId],
      );

      expect(await errorCode(activate(harness, generated.key))).toBe("reactivation_not_authorized");

      await harness.db.query(
        `insert into key_reactivations (key_id, ban_id, authorized_by, reason, authorized_at)
         values ($1, $2, $3, 'approved reactivation', $4)`,
        [generated.keyId, ban.rows[0]!.id, harness.owner.userId, harness.clock.now().toISOString()],
      );

      const reactivated = await activate(harness, generated.key, { hwid: "abcdef123456" });
      expect(reactivated.body.reactivationConsumed).toBe(true);

      const authorization = await harness.db.query<{ consumed_at: Date | null }>(
        "select consumed_at from key_reactivations where key_id = $1",
        [generated.keyId],
      );
      expect(authorization.rows[0]!.consumed_at).not.toBeNull();

      await harness.db.query("update keys set status = 'suspended' where id = $1", [
        generated.keyId,
      ]);
      expect(await errorCode(activate(harness, generated.key))).toBe("reactivation_not_authorized");
    } finally {
      await harness.close();
    }
  });
});

describe("HWID reset", () => {
  it("enforces the cooldown and revokes the current session", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key, { hwid: "abcdef123456" });
      const reset = await harness.service.resetHwid({
        session: ownerSession(harness),
        request: requestFor(),
        keyId: generated.keyId,
        idempotencyKey: randomUUID(),
      });
      expect(reset.hwidResetCount).toBe(1);

      expect(
        await errorCode(
          harness.service.resetHwid({
            session: ownerSession(harness),
            request: requestFor(),
            keyId: generated.keyId,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).toBe("hwid_reset_cooldown");

      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "script-one",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("session_required");
    } finally {
      await harness.close();
    }
  });

  it("enforces the configured cap", async () => {
    const harness = await createKeyHarness();
    try {
      await harness.db.query(
        `insert into system_settings (key, value) values
           ('hwid.reset_cooldown_hours', '0'::jsonb),
           ('hwid.max_resets', '1'::jsonb)`,
      );
      const generated = await generate(harness);
      await activate(harness, generated.key, { hwid: "abcdef123456" });
      const first = await harness.service.resetHwid({
        session: ownerSession(harness),
        request: requestFor(),
        keyId: generated.keyId,
        idempotencyKey: randomUUID(),
      });
      expect(first.hwidResetCount).toBe(1);
      expect(first.nextResetAllowedAt).toBeNull();
      expect(
        await errorCode(
          harness.service.resetHwid({
            session: ownerSession(harness),
            request: requestFor(),
            keyId: generated.keyId,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).toBe("hwid_reset_limit_reached");
    } finally {
      await harness.close();
    }
  });
});

describe("admin controls and owner reads", () => {
  it("admin revoke drops the session immediately", async () => {
    const harness = await createKeyHarness();
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const generated = await generate(harness);
      const activated = await activate(harness, generated.key);

      const revoked = await harness.service.adminRevoke({
        session: sessionFor(harness.owner),
        request: requestFor(),
        keyId: generated.keyId,
        reason: "test revoke",
      });
      expect(revoked.status).toBe("revoked");

      expect(
        await errorCode(
          harness.service.validate({
            session: ownerSession(harness),
            request: requestFor(),
            key: generated.key,
            scriptId: "script-one",
            keySessionToken: activated.body.keySessionToken!,
          }),
        ),
      ).toBe("revoked_key");
    } finally {
      await harness.close();
    }
  });

  it("lists own keys without raw key material or HWID", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      await activate(harness, generated.key, { hwid: "abcdef123456" });
      const keys = await harness.service.listOwnKeys(ownerSession(harness));
      const serialized = JSON.stringify(keys);
      expect(serialized).not.toContain(generated.key);
      expect(serialized).not.toContain("abcdef123456");
      expect(keys[0]).toMatchObject({
        keyId: generated.keyId,
        status: "active",
        deviceBound: true,
      });
    } finally {
      await harness.close();
    }
  });

  it("admin reset bypasses the user cooldown and is attributed to the admin", async () => {
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      await activate(harness, generated.key, { hwid: "abcdef123456" });
      await harness.service.resetHwid({
        session: ownerSession(harness),
        request: requestFor(),
        keyId: generated.keyId,
        idempotencyKey: randomUUID(),
      });
      const adminReset = await harness.service.adminResetHwid({
        session: sessionFor(harness.owner),
        request: requestFor(),
        keyId: generated.keyId,
        reason: "support request",
      });
      expect(adminReset.performedBy).toBe("admin");

      const history = await harness.service.adminDevices(ownerSession(harness), generated.keyId);
      expect(history.map((entry) => entry.event)).toEqual(
        expect.arrayContaining(["reset_self", "reset_admin"]),
      );
    } finally {
      await harness.close();
    }
  });
});

describe("concurrent activation", () => {
  it("lets exactly one of two parallel activations succeed", async () => {
    // PGlite serializes transactions behind a mutex; this proves the locked
    // state transition, not independent PostgreSQL row contention.
    const harness = await createKeyHarness();
    try {
      const generated = await generate(harness);
      const results = await Promise.allSettled([
        activate(harness, generated.key, { hwid: "abcdef123456" }),
        activate(harness, generated.key, { hwid: "abcdef123456" }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as AppError).code).toBe("already_owned");

      const active = await harness.db.query<{ count: number }>(
        "select count(*)::int as count from key_sessions where key_id = $1 and status = 'active'",
        [generated.keyId],
      );
      expect(active.rows[0]!.count).toBe(1);
    } finally {
      await harness.close();
    }
  });
});
