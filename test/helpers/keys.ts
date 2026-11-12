import type { SessionContext } from "@/middleware/session";
import type { TestDatabase } from "./db";
import { createTestDatabase } from "./db";
import { FakeClock } from "./auth";
import { createKeyService, type KeyService } from "@/modules/keys/service";

export const TEST_KEY_SESSION_SECRET = "test-key-session-secret-0123456789";
export const TEST_HWID_SECRET = "test-hwid-secret-value-0123456789";

export interface TestUser {
  userId: string;
  discordId: string;
  username: string;
  roles: string[];
}

export interface KeyHarness extends TestDatabase {
  clock: FakeClock;
  service: KeyService;
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

  const service = createKeyService({
    db: database.db,
    clock: clock.now,
    sessionSecret: TEST_KEY_SESSION_SECRET,
    hwidSecret: TEST_HWID_SECRET,
  });

  return { ...database, clock, service, owner, other };
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
  return result.rows[0]!.id;
}
