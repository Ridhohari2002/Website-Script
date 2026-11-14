import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the new default is fail-closed and that the migration does not rewrite
 * existing purchase rows. The SQL is applied in filename order against embedded
 * PostgreSQL, matching the production migration runner.
 */

const migrationsDirectory = join(process.cwd(), "supabase", "migrations");

let db: PGlite;
let existingKeyId: string;

async function apply(filename: string): Promise<void> {
  await db.exec(await readFile(join(migrationsDirectory, filename), "utf8"));
}

async function makeKey(hash: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "insert into keys (key_hash, status) values ($1, 'active') returning id",
    [hash],
  );
  return result.rows[0]!.id;
}

async function insertPurchase(
  keyId: string,
  paymentStatus?: string,
): Promise<{ payment_status: string }> {
  const result = await db.query<{ payment_status: string }>(
    paymentStatus === undefined
      ? `insert into key_purchases (key_id, buyer_discord_id)
         values ($1, 'buyer-fixture')
         returning payment_status`
      : `insert into key_purchases (key_id, buyer_discord_id, payment_status)
         values ($1, 'buyer-fixture', $2)
         returning payment_status`,
    paymentStatus === undefined ? [keyId] : [keyId, paymentStatus],
  );
  return result.rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await apply("0001_init.sql");
  await apply("0002_executor_first.sql");
  await apply("0003_executor_review_fixes.sql");

  existingKeyId = await makeKey("payment-status-existing-key");
  await db.query(
    `insert into key_purchases (key_id, buyer_discord_id, payment_status)
     values ($1, 'existing-buyer', 'paid')`,
    [existingKeyId],
  );

  await apply("0004_payment_status_default.sql");
});

afterAll(async () => {
  await db.close();
});

describe("key_purchases.payment_status default", () => {
  it("defaults a new purchase to pending instead of paid", async () => {
    const purchase = await insertPurchase(await makeKey("payment-status-default-key"));
    expect(purchase.payment_status).toBe("pending");
  });

  it("keeps an explicit legacy value valid", async () => {
    const purchase = await insertPurchase(await makeKey("payment-status-legacy-key"), "legacy");
    expect(purchase.payment_status).toBe("legacy");
  });

  it("does not grant paid unless it is written explicitly", async () => {
    const keyId = await makeKey("payment-status-explicit-paid-key");
    const purchase = await insertPurchase(keyId, "paid");
    expect(purchase.payment_status).toBe("paid");

    const second = await insertPurchase(await makeKey("payment-status-default-key-2"));
    expect(second.payment_status).not.toBe("paid");
  });

  it("leaves existing purchase records unchanged", async () => {
    const result = await db.query<{ payment_status: string }>(
      "select payment_status from key_purchases where key_id = $1",
      [existingKeyId],
    );
    expect(result.rows[0]?.payment_status).toBe("paid");
  });

  it("still rejects a status outside the allowed set", async () => {
    await expect(
      insertPurchase(await makeKey("payment-status-invalid-key"), "captured"),
    ).rejects.toThrow(/key_purchases_payment_status_check/);
  });
});
