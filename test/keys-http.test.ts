import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/core/env";
import { createKeyService } from "@/modules/keys/service";
import { createAuthHarness, type AuthHarness } from "./helpers/auth";
import { BASE, createHttpHarness, ORIGIN, performLogin } from "./helpers/http";
import { entitleKey, seedScript, TEST_HWID_SECRET, TEST_KEY_SESSION_SECRET } from "./helpers/keys";

afterAll(() => resetEnvCache());

function keyServiceFor(harness: AuthHarness) {
  return createKeyService({
    db: harness.db,
    clock: harness.clock.now,
    sessionSecret: TEST_KEY_SESSION_SECRET,
    hwidSecret: TEST_HWID_SECRET,
  });
}

function headers(cookie: string, csrf: string, extra: Record<string, string> = {}) {
  return {
    cookie,
    origin: ORIGIN,
    "x-csrf-token": csrf,
    "content-type": "application/json",
    ...extra,
  };
}

async function generateKey(harness: AuthHarness) {
  const handler = createHttpHarness(harness.service, { keys: keyServiceFor(harness) });
  const login = await performLogin(handler);
  const response = await handler.call(
    null,
    new Request(`${BASE}/api/admin/keys`, {
      method: "POST",
      headers: headers(login.cookie, login.csrf),
      body: JSON.stringify({ count: 1, type: "paid" }),
    }),
    ["admin", "keys"],
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  const key = body.keys[0] as { keyId: string; key: string };
  await entitleKey(harness.db, key.keyId);
  return { handler, login, key };
}

describe("key HTTP endpoints", () => {
  it("runs generate, activate, validate, list, device, and reset through the pipeline", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      await seedScript(harness.db, { publicId: "script-one" });
      const { handler, login, key } = await generateKey(harness);

      const activate = await handler.call(
        null,
        new Request(`${BASE}/api/keys/activate`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf, { "idempotency-key": randomUUID() }),
          body: JSON.stringify({ key: key.key, hwid: "AB-CD-EF-12-34-56" }),
        }),
        ["keys", "activate"],
      );
      expect(activate.status).toBe(201);
      const activated = await activate.json();
      expect(activated.keySessionToken).toBeTruthy();
      expect(JSON.stringify(activated)).not.toContain("ABCDEF");
      expect(JSON.stringify(activated)).not.toContain("abcdef");

      const validate = await handler.call(
        null,
        new Request(`${BASE}/api/keys/validate`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf, {
            authorization: `Bearer ${activated.keySessionToken}`,
          }),
          body: JSON.stringify({
            key: key.key,
            scriptId: "script-one",
            hwid: "abcdef123456",
          }),
        }),
        ["keys", "validate"],
      );
      expect(validate.status).toBe(200);
      expect((await validate.json()).valid).toBe(true);

      const list = await handler.call(
        null,
        new Request(`${BASE}/api/keys/me`, { headers: { cookie: login.cookie } }),
        ["keys", "me"],
      );
      expect(list.status).toBe(200);
      const listed = await list.json();
      expect(JSON.stringify(listed)).not.toContain(key.key);
      expect(JSON.stringify(listed)).not.toContain("abcdef123456");
      expect(listed.keys).toHaveLength(1);
      expect(listed.keys[0]).toMatchObject({ keyId: key.keyId, status: "active" });

      const devices = await handler.call(
        null,
        new Request(`${BASE}/api/keys/${key.keyId}/devices`, {
          headers: { cookie: login.cookie },
        }),
        ["keys", key.keyId, "devices"],
      );
      expect(devices.status).toBe(200);
      const deviceBody = await devices.json();
      expect(deviceBody.devices[0].event).toBe("bound");
      expect(JSON.stringify(deviceBody)).not.toContain("abcdef123456");

      const selfReset = await handler.call(
        null,
        new Request(`${BASE}/api/keys/reset-hwid`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf, { "idempotency-key": randomUUID() }),
          body: JSON.stringify({ keyId: key.keyId }),
        }),
        ["keys", "reset-hwid"],
      );
      expect(selfReset.status).toBe(404);

      const reset = await handler.call(
        null,
        new Request(`${BASE}/api/admin/keys/${key.keyId}/reset-hwid`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf),
          body: JSON.stringify({ reason: "support request" }),
        }),
        ["admin", "keys", key.keyId, "reset-hwid"],
      );
      expect(reset.status).toBe(200);
      expect((await reset.json()).performedBy).toBe("admin");
    } finally {
      await harness.close();
    }
  });

  it("requires an Idempotency-Key for activation", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      const { handler, login, key } = await generateKey(harness);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/keys/activate`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf),
          body: JSON.stringify({ key: key.key }),
        }),
        ["keys", "activate"],
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("bad_request");
    } finally {
      await harness.close();
    }
  });

  it("rejects a mutation without the CSRF token", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      const { handler, login, key } = await generateKey(harness);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/keys/activate`, {
          method: "POST",
          headers: {
            cookie: login.cookie,
            origin: ORIGIN,
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
          },
          body: JSON.stringify({ key: key.key }),
        }),
        ["keys", "activate"],
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("denies admin key generation to a non-admin account", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "999988887777666655" });
    try {
      const handler = createHttpHarness(harness.service, { keys: keyServiceFor(harness) });
      const login = await performLogin(handler);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/admin/keys`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf),
          body: JSON.stringify({ count: 1 }),
        }),
        ["admin", "keys"],
      );
      expect(response.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it("returns a stable banned_key code without exposing internals", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      const { handler, login, key } = await generateKey(harness);
      await harness.db.query(
        "update keys set status = 'banned', banned_at = now(), ban_reason = 'internal note' where id = $1",
        [key.keyId],
      );
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/keys/activate`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf, { "idempotency-key": randomUUID() }),
          body: JSON.stringify({ key: key.key }),
        }),
        ["keys", "activate"],
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe("banned_key");
      expect(JSON.stringify(body)).not.toContain("internal note");
      expect(JSON.stringify(body)).not.toContain(key.key);
    } finally {
      await harness.close();
    }
  });

  it("requires a bearer key session token for validation", async () => {
    const harness = await createAuthHarness({ ownerDiscordId: "111122223333444455" });
    try {
      const { handler, login, key } = await generateKey(harness);
      const response = await handler.call(
        null,
        new Request(`${BASE}/api/keys/validate`, {
          method: "POST",
          headers: headers(login.cookie, login.csrf),
          body: JSON.stringify({ key: key.key, scriptId: "script-one" }),
        }),
        ["keys", "validate"],
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("bad_request");
    } finally {
      await harness.close();
    }
  });
});
