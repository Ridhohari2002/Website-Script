import { getRateLimitSecret, loadEnv } from "@/core/env";
import { hmacHex } from "@/db/hashing";
import { withPgTransaction } from "@/db/transaction";
import { logger } from "@/core/logger";

/**
 * D11 shared rate limiter.
 *
 * Algorithm: fixed window. `window_start` is the window boundary rounded down
 * to a multiple of the window length, so a counter resets exactly at each
 * boundary. A request at 09:59:59 and one at 10:00:00 fall in different windows.
 *
 * Buckets are checked and incremented in one transaction. If any bucket would
 * exceed its limit the whole transaction rolls back, so no partial increment is
 * left behind when several dimensions are evaluated together.
 */

export type RateLimitKind = "ip" | "user" | "key" | "route";
export type FailurePolicy = "fail_closed" | "fail_open";

export interface RateLimitDimension {
  kind: RateLimitKind;
  value: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  exceeded?: RateLimitKind;
  degraded?: boolean;
}

export interface RateLimiter {
  consume(
    dimensions: RateLimitDimension[],
    options?: { failurePolicy?: FailurePolicy },
  ): Promise<RateLimitDecision>;
}

class ExceededSignal extends Error {
  constructor(
    readonly kind: RateLimitKind,
    readonly retryAfterSeconds: number,
  ) {
    super("rate limit exceeded");
  }
}

function windowStart(now: Date, windowSeconds: number): Date {
  const ms = now.getTime();
  const size = windowSeconds * 1000;
  return new Date(Math.floor(ms / size) * size);
}

export function bucketIdentifier(
  kind: RateLimitKind,
  value: string,
  secret: string,
  version: string,
): string {
  return hmacHex(secret, `${version}:${kind}:${value}`);
}

export class PostgresRateLimiter implements RateLimiter {
  async consume(
    dimensions: RateLimitDimension[],
    options: { failurePolicy?: FailurePolicy } = {},
  ): Promise<RateLimitDecision> {
    const policy = options.failurePolicy ?? "fail_closed";
    const secret = getRateLimitSecret();
    const version = loadEnv().RATE_LIMIT_HMAC_KEY_VERSION;
    const now = new Date();

    try {
      await withPgTransaction(async (client) => {
        for (const dimension of dimensions) {
          const hash = bucketIdentifier(dimension.kind, dimension.value, secret, version);
          const bucketKey = `${version}:${dimension.kind}:${hash}:${dimension.windowSeconds}`;
          const start = windowStart(now, dimension.windowSeconds);
          const expires = new Date(start.getTime() + dimension.windowSeconds * 1000);

          const result = await client.query<{ counter: number }>(
            `insert into rate_limit_counters (bucket_key, window_start, counter, expires_at)
             values ($1, $2, 1, $3)
             on conflict (bucket_key, window_start)
             do update set counter = rate_limit_counters.counter + 1
             returning counter`,
            [bucketKey, start.toISOString(), expires.toISOString()],
          );

          const counter = result.rows[0]?.counter ?? 1;
          if (counter > dimension.limit) {
            throw new ExceededSignal(dimension.kind, dimension.windowSeconds);
          }
        }
      });
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      if (error instanceof ExceededSignal) {
        return {
          allowed: false,
          retryAfterSeconds: error.retryAfterSeconds,
          exceeded: error.kind,
        };
      }

      logger.error("rate limiter store unavailable", {
        event: "rate_limit.store_error",
        failurePolicy: policy,
        error: error instanceof Error ? error.message : String(error),
      });

      if (policy === "fail_open") {
        return { allowed: true, retryAfterSeconds: 0, degraded: true };
      }
      // Fail closed: reject with a retry hint rather than bypassing the limit.
      return { allowed: false, retryAfterSeconds: 30, degraded: true };
    }
  }
}

export const rateLimiter: RateLimiter = new PostgresRateLimiter();
