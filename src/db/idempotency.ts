import type { PoolClient } from "pg";
import { getRateLimitSecret } from "@/core/env";
import { withPgTransaction } from "@/db/transaction";
import { keyHash, requestHash } from "@/db/hashing";
import { conflict, idempotencyConflict } from "@/core/errors";

/**
 * D10 idempotency store.
 *
 * - Only a hash of the supplied key is stored (HMAC with a server secret).
 * - A canonical request hash detects reuse of the same key with a different body.
 * - The claim and the caller's mutation run in one transaction.
 * - Replays return the stored safe response; one-time secrets are never stored.
 */

export interface IdempotencyResult<T> {
  body: T;
  replayed: boolean;
  /** Present only on the first successful execution; never stored or replayed. */
  oneTimeSecret?: string;
}

export interface IdempotencyOptions<T> {
  scope: string;
  key: string;
  request: unknown;
  actorId?: string | null;
  ttlSeconds?: number;
  /** Runs the protected mutation inside the same transaction as the claim. */
  run: (client: PoolClient) => Promise<{ body: T; oneTimeSecret?: string }>;
}

interface KeyRow {
  id: string;
  request_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export async function withIdempotency<T>(
  options: IdempotencyOptions<T>,
): Promise<IdempotencyResult<T>> {
  const secret = getRateLimitSecret();
  const hashedKey = keyHash(options.key, secret);
  const hashedRequest = requestHash(options.request);
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  try {
    return await withPgTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into idempotency_keys
           (scope, key_hash, request_hash, actor_id, status, expires_at)
         values ($1, $2, $3, $4, 'processing', now() + ($5::text || ' seconds')::interval)
         on conflict (scope, key_hash) do nothing
         returning id`,
        [options.scope, hashedKey, hashedRequest, options.actorId ?? null, String(ttl)],
      );

      if (inserted.rowCount === 0) {
        // Another request holds, or already completed, this key.
        const existing = await client.query<KeyRow>(
          `select id, request_hash, status, response_status, response_body
             from idempotency_keys
            where scope = $1 and key_hash = $2
            for update`,
          [options.scope, hashedKey],
        );
        const row = existing.rows[0];
        if (!row) throw conflict("Idempotency record vanished during claim");

        if (row.request_hash !== hashedRequest) {
          throw idempotencyConflict();
        }
        if (row.status === "completed") {
          return { body: row.response_body as T, replayed: true };
        }
        throw conflict("A request with this idempotency key is still processing");
      }

      const result = await options.run(client);

      // Persist only the safe body. A one-time secret is never written here.
      await client.query(
        `update idempotency_keys
            set status = 'completed',
                response_status = 200,
                response_body = $2::jsonb,
                one_time_secret_issued = $3,
                updated_at = now()
          where id = $1`,
        [inserted.rows[0]!.id, JSON.stringify(result.body), Boolean(result.oneTimeSecret)],
      );

      return { body: result.body, replayed: false, oneTimeSecret: result.oneTimeSecret };
    });
  } catch (error) {
    // The transaction rolled back, so the claim is gone and a retry is allowed.
    throw error;
  }
}
