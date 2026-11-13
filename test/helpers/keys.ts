import type { SessionContext } from "@/middleware/session";
import type { TestDatabase } from "./db";
import { createTestDatabase } from "./db";
import { FakeClock } from "./auth";
import { createKeyService, type KeyService } from "@/modules/keys/service";
import { createExecutorService, type ExecutorService } from "@/modules/executor/service";

export const TEST_KEY_SESSION_SECRET = "test-key-session-secret-0123456789";
export const TEST_HWID_SECRET = "test-hwid-secret-value-0123456789";
export const TEST_KEY_SECRET = "test-dedicated-key-secret-0123456789";

export interface TestUser {
  userId: string;
  discordId: string;
  username: string;
  roles: string[];
}

export interface KeyHarness extends TestDatabase {
  clock: FakeClock;
  service: KeyService;
  executor: ExecutorService;
  owner: TestUser;
  other: TestUser;
}

async function insertUser(
  db: TestDatabase["db"],
  input: { discordId: string; username: string; roles: string[] },
): Promise<TestUser> {
  const inserted = await db.query<{ id: string }>(
    "insert into users (discord_id, username) values ($1, $2) returning id",
    [input.discordId, input.username],
  );
  const userId = inserted.rows[0]!.id;
  for (const role of input.roles) {
    await db.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, role]);
  }
  return {
    userId,
    discordId: input.discordId,
    username: input.username,
    roles: input.roles,
  };
}

export async function createKeyHarness(options: { clock?: FakeClock } = {}): Promise<KeyHarness> {
  const database = await createTestDatabase();
  const clock = options.clock ?? new FakeClock();
  const owner = await insertUser(database.db, {
    discordId: "111122223333444455",
    username: "Owner",
    roles: ["user", "admin"],
  });
  const other = await insertUser(database.db, {
    discordId: "999988887777666655",
    username: "Other",
    roles: ["user"],
  });

  const shared = {
    db: database.db,
    clock: clock.now,
    sessionSecret: TEST_KEY_SESSION_SECRET,
    keySecret: TEST_KEY_SECRET,
    keySecretVersion: "v2" as const,
    hwidSecret: TEST_HWID_SECRET,
  };
  const service = createKeyService(shared);
  const executor = createExecutorService(shared);

  return { ...database, clock, service, executor, owner, other };
}

export function sessionFor(user: TestUser, roles: string[] = user.roles): SessionContext {
  return {
    userId: user.userId,
    roles,
    user: {
      id: user.userId,
      discordId: user.discordId,
      username: user.username,
      avatarUrl: null,
    },
  };
}

export function requestFor(path = "/api/keys/test"): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      "user-agent": "vitest",
    },
  });
}

/**
 * Seeds a script plus a product that maps it. Tests must grant the product to a
 * key explicitly; nothing is entitled by default.
 */
export async function seedScript(
  db: TestDatabase["db"],
  input: { publicId: string; status?: string; enabled?: boolean } = { publicId: "script-one" },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into scripts (public_id, name, status, enabled)
     values ($1, $2, $3, $4)
     returning id`,
    [input.publicId, input.publicId, input.status ?? "published", input.enabled ?? true],
  );
  const scriptId = result.rows[0]!.id;

  const product = await db.query<{ id: string }>(
    `insert into products (code, name) values ($1, $2)
     on conflict (code) do update set name = excluded.name
     returning id`,
    [`product:${input.publicId}`, `Product for ${input.publicId}`],
  );
  await db.query(
    `insert into product_scripts (product_id, script_id) values ($1, $2)
     on conflict do nothing`,
    [product.rows[0]!.id, scriptId],
  );
  return scriptId;
}

/** Grants every product to a key, simulating an approved purchase mapping. */
export async function entitleKey(db: TestDatabase["db"], keyId: string): Promise<void> {
  await db.query(
    `insert into key_entitlements (key_id, product_id, source, status, starts_at)
     select $1, p.id, 'admin', 'active', $2 from products p
     on conflict (key_id, product_id) do nothing`,
    [keyId, "2020-01-01T00:00:00.000Z"],
  );
}
