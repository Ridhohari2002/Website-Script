import { describe, expect, it } from "vitest";
import { runAuthRetention } from "@/modules/auth/retention";
import { createAuthHarness, loginThroughService } from "./helpers/auth";

const DAY = 24 * 60 * 60 * 1000;

describe("auth retention", () => {
  it("redacts old IP and user-agent values without deleting rows", async () => {
    const harness = await createAuthHarness();
    try {
      await loginThroughService(harness.service, { ip: "203.0.113.10" });
      const now = harness.clock.now();
      const old = new Date(now.getTime() - 31 * DAY);

      const user = await harness.db.query<{ id: string }>("select id from users");
      const userId = user.rows[0]!.id;

      await harness.db.query("update audit_logs set created_at = $1", [old.toISOString()]);
      await harness.db.query(
        `insert into audit_logs (actor_user_id, action, target_type, target_id, metadata, ip, created_at)
         values ($1, 'auth.login', 'user', $4, '{"provider":"discord"}'::jsonb, '198.51.100.7', $2),
                ($1, 'auth.logout', 'session', 'old-session', '{}'::jsonb, '198.51.100.8', $3)`,
        [userId, old.toISOString(), old.toISOString(), userId],
      );
      await harness.db.query(
        "update sessions set ip = '203.0.113.10', user_agent = 'Old Agent', created_at = $1",
        [old.toISOString()],
      );

      const result = await runAuthRetention(harness.db, { now });
      expect(result.auditIpsRedacted).toBe(3);
      expect(result.sessionMetadataRedacted).toBe(1);

      const audits = await harness.db.query<{
        action: string;
        ip: string | null;
        metadata: unknown;
      }>("select action, ip, metadata from audit_logs order by created_at asc");
      expect(audits.rows).toHaveLength(3);
      expect(audits.rows.every((row) => row.ip === null)).toBe(true);
      expect(audits.rows[0]!.metadata).toEqual({ provider: "discord" });

      const sessions = await harness.db.query<{ ip: string | null; user_agent: string | null }>(
        "select ip, user_agent from sessions",
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]!.ip).toBeNull();
      expect(sessions.rows[0]!.user_agent).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("keeps recent metadata and is safe to rerun", async () => {
    const harness = await createAuthHarness();
    try {
      await loginThroughService(harness.service, { ip: "203.0.113.10" });
      const now = harness.clock.now();

      await harness.db.query(
        `insert into audit_logs (action, target_type, target_id, metadata, ip, created_at)
         values ('auth.login', 'user', 'recent', '{}'::jsonb, '198.51.100.9', $1)`,
        [now.toISOString()],
      );

      const first = await runAuthRetention(harness.db, { now });
      expect(first.auditIpsRedacted).toBe(0);
      expect(first.sessionMetadataRedacted).toBe(0);

      const second = await runAuthRetention(harness.db, { now });
      expect(second.auditIpsRedacted).toBe(0);
      expect(second.sessionMetadataRedacted).toBe(0);

      const audits = await harness.db.query<{ ip: string | null }>(
        "select ip from audit_logs order by created_at asc",
      );
      expect(audits.rows).toHaveLength(2);
      expect(audits.rows.every((row) => row.ip !== null)).toBe(true);

      const sessions = await harness.db.query<{ ip: string | null; user_agent: string | null }>(
        "select ip, user_agent from sessions",
      );
      expect(sessions.rows[0]!.ip).toBe("203.0.113.10");
      expect(sessions.rows[0]!.user_agent).not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("deletes consumed and expired OAuth states and keeps live ones", async () => {
    const harness = await createAuthHarness();
    try {
      const now = harness.clock.now();
      const old = new Date(now.getTime() - 11 * 60 * 1000);
      const future = new Date(now.getTime() + 10 * 60 * 1000);

      await harness.db.query(
        `insert into oauth_states (state_hash, code_verifier, redirect_path, created_at, expires_at, consumed_at)
         values ('consumed-hash', 'consumed-verifier', '/', $1, $2, $1),
                ('expired-hash', 'expired-verifier', '/', $1, $2, null),
                ('live-hash', 'live-verifier', '/', $1, $3, null)`,
        [old.toISOString(), old.toISOString(), future.toISOString()],
      );

      const result = await runAuthRetention(harness.db, { now });
      expect(result.oauthStatesDeleted).toBe(2);

      const states = await harness.db.query<{ state_hash: string; code_verifier: string | null }>(
        "select state_hash, code_verifier from oauth_states",
      );
      expect(states.rows).toEqual([{ state_hash: "live-hash", code_verifier: "live-verifier" }]);
    } finally {
      await harness.close();
    }
  });
});
