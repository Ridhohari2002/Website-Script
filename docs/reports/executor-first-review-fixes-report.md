# Executor-First Architecture — Review Fixes Report

**Date:** 2026-11-13
**Branch:** `feat/executor-first-license-architecture`
**Scope:** fixes for the executor-first review findings F1–F6. No merge, deploy, or production migration was performed.

## 1. Original findings

| ID | Finding |
|---|---|
| F1 | A legacy Discord-claimed key with no HWID could be treated as a new executor first claim, overwriting claim metadata and incrementing `activation_count`. |
| F2 | Executor rate limiting trusted `x-key-fingerprint` and the bearer token as bucket identities, before any server-side key lookup. |
| F3 | Revoking a `superseded` session reported a new revocation and wrote misleading audit/device events. The existing test did not prove that another active session stayed active. |
| F4 | New key hashes could silently fall back to version 1 with `SESSION_HMAC_SECRET`; production had no dedicated `KEY_HMAC_SECRET` requirement, and the read/write distinction was implicit. |
| F5 | The PGlite concurrency suite could not prove real PostgreSQL row-lock behavior, and the executor flows had no real-PostgreSQL concurrency suite. |
| F6 | Additional review of transaction boundaries, nonce atomicity, entitlement/expiry checks, admin-only HWID reset, audit durability, raw credential leakage, buyer identity, and revoke/replace races. |

## 2. Root cause

- **F1:** `firstClaim` was derived from `bound_hwid_hash === null` only. Discord-claimed keys without an HWID therefore looked unused. The update also used `coalesce` in a way that could convert claim metadata implicitly.
- **F2:** Route-level dimension builders read `x-key-fingerprint` and the raw bearer token. The fingerprint is client-controlled, and the token bucket ran before the server proved the token existed.
- **F3:** `revokeSession()` only special-cased `status === "revoked"`. A `superseded` row fell into the `update ... where status = 'active'` path and then still emitted a revocation event and audit row.
- **F4:** `getKeySecretState()` was used for both reads and writes. Without a dedicated secret it silently wrote version 1 hashes using the session secret, and production accepted that configuration.
- **F5:** The existing suite used PGlite, which serializes transactions, so row-lock contention and nonce uniqueness races were not observable.
- **F6:** Mostly consequences of the above; the revoke path and claim path were the concrete defects.

## 3. Files changed

| File | Change |
|---|---|
| `src/core/env.ts` | Production now requires `KEY_HMAC_SECRET`; `KEY_HMAC_KEY_VERSION` must be `v2` when the secret is set; added `getConfiguredKeySecret()` for reads and kept `getKeySecretState()` as the write-side resolver. |
| `src/modules/keys/service.ts` | Write/read key-hash material separated, legacy version 1 reads retained, explicit `adminAuthorizeExecutorClaim()`, claim authorization columns on `KeyRow`. |
| `src/modules/keys/audit.ts` | Added `key.executor_claim_authorize` and `key.executor_claim_authorize_failed`. |
| `src/modules/executor/service.ts` | Claim classification (`unclaimed` / `executor` / `legacy_authorized` / `legacy_recovery`), no silent legacy conversion, no activation increment on recovery/reactivation, server-derived rate-limit buckets, correct revoke outcomes. |
| `src/routes/executor.ts` | Removed `x-key-fingerprint` and token-based route buckets; route limiting is IP-only. Documented the trusted-proxy assumption. |
| `src/routes/keys.ts` | Added `POST /api/admin/keys/:id/executor-claim`. |
| `src/validators/keys.ts` | Added `adminAuthorizeExecutorClaimSchema`. |
| `supabase/migrations/0003_executor_review_fixes.sql` | Additive columns/index for audited legacy authorization and a conservative legacy backfill. |
| `.env.example` | Documents `KEY_HMAC_SECRET` as required in production and `KEY_HMAC_KEY_VERSION=v2`. |
| `test/helpers/keys.ts` | Injectable in-memory rate limiter, legacy v1 key service helper. |
| `test/executor.test.ts` | New F1/F2/F3 regressions and corrected revoke test. |
| `test/executor-route.test.ts` | Proves the route bucket is IP-only and ignores spoofed fingerprint/bearer headers. |
| `test/env.test.ts` | Production key-secret requirements, incorrect version rejection, configured-secret read behavior. |
| `test/auth-config.test.ts` | Production fixture now includes `KEY_HMAC_SECRET`. |
| `test/integration/executor-concurrency.integration.ts` | Real-PostgreSQL activation/nonce/entitlement concurrency suite. |
| `test/integration/auth-concurrency.integration.ts` | Skips honestly when the test database is not configured instead of failing with a misleading result. |
| `docs/reports/executor-first-review-fixes-report.md` | This report. |

## 4. Exact fixes

### F1 — Legacy claim safety

- Added claim classification before any key mutation:
  - `claim_kind === "executor"` → existing executor claim.
  - `executor_claim_authorized_at !== null` → admin-authorized legacy migration.
  - any legacy evidence (`discord` claim kind, owner Discord id, `claimed_at`, `activation_count > 0`) with a matching bound HWID → recovery/reactivation.
  - legacy evidence without a matching HWID → `already_owned` denial. No new session, no claim mutation.
  - no legacy evidence → genuine first claim.
- `activation_count` increments only for a genuine, unclaimed first binding. Recoveries, reactivations, and admin-authorized migrations keep the existing count.
- The executor path never writes `owner_discord_id`, `user_id`, `claim_ref` buyer identity, or purchase rows. `claim_kind` is only changed to `executor` for a genuine first claim or an explicit admin authorization.
- The migration backfill marks keys with claim evidence as `discord`; it does not convert them to executor.
- Added an audited admin endpoint and service method for operators who intentionally migrate a legacy key.

### F2 — Rate-limit trust boundary

- Route limits are IP-only:
  - activation: 20/min,
  - validation: 240/min,
  - revocation: 60/min.
- Service limits run after a server-side HMAC hash lookup:
  - activation: 5/min keyed by `keys.id`,
  - validation: 120/min keyed by `executor_sessions.id`,
  - revocation: 10/min keyed by `executor_sessions.id`.
- Bucket values are never the plaintext key, token, or a client header. `PostgresRateLimiter` HMACs the value again before storage.
- `x-key-fingerprint` is no longer read anywhere.
- Unknown keys never create a key bucket; they remain covered by the IP limit and receive the same generic denial surface.
- Denials use the existing generic `rate_limited` error and do not reveal whether a key exists.
- Trust assumption: `x-forwarded-for`/`x-real-ip` are trusted only behind the deployment's reverse proxy. Without that proxy they are client-controlled, so the IP bucket is a coarse abuse guard, never an authorization proof.

### F3 — Session revoke correctness

- `ExecutorRevokeResult` now includes `outcome` and `status`: `revoked`, `already_revoked`, `superseded`, or `expired`.
- A superseded session returns `outcome: "superseded"` and writes no device event or audit row.
- An already revoked session returns `outcome: "already_revoked"`, idempotently and without a second audit row.
- Only the calling session row is updated. The key row, buyer identity, and other sessions are untouched.
- `adminRevokeSession()` reports the same explicit outcomes.
- The misleading test was replaced and expanded to cover active, repeated, superseded, other-key active, and buyer-identity preservation.

### F4 — Dedicated key HMAC secret

- Writes resolve the dedicated secret through `getKeySecretState()`; production refuses to load without `KEY_HMAC_SECRET`.
- Reads use `getConfiguredKeySecret()` plus the legacy `SESSION_HMAC_SECRET` candidate. A version 1 key remains verifiable after version 2 is configured.
- `KEY_HMAC_KEY_VERSION` must be `v2` when `KEY_HMAC_SECRET` is set.
- Existing web key sessions and Discord OAuth sessions are unaffected: they continue to use `SESSION_HMAC_SECRET` and their own hash versions.
- No secret value is printed in errors, tests, logs, or this report.

### F5 — Real PostgreSQL concurrency

- Added `test/integration/executor-concurrency.integration.ts` using only `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL`.
- It verifies migrations `0001`, `0002`, and `0003` are recorded and the new key columns exist.
- It covers:
  - concurrent same-key/same-HWID activation,
  - concurrent different-HWID activation,
  - concurrent reuse of one nonce,
  - entitlement revocation followed by validation denial,
  - one active executor session per key,
  - isolated cleanup by fixture key/user/script/product ids.
- Both concurrency files now skip when the dedicated test database is absent, so the result is honestly reported as NOT RUN rather than PASS.

### F6 — Additional review

- Key/session rows are locked with `for update` before decisions.
- Nonce consumption is an atomic `insert ... on conflict (nonce_hash) do nothing`; `rowCount === 0` is replay.
- Entitlement status, expiry, script status, idle expiry, and absolute expiry remain enforced before a grant.
- HWID reset remains admin-only; the self-service route still returns 404.
- Denial audit is written after the denied transaction rolls back and cannot mask the denial.
- Executor code stores only HMAC HWID hashes, fingerprints, and session-token hashes. No raw HWID or plaintext key/token is stored or logged.
- Buyer Discord identity is never modified by executor activity.
- Revoke/replace races serialize on the session row lock; a superseded session cannot be reported as freshly revoked.

## 5. New regression tests

- F1:
  - legacy Discord claim with no HWID is denied until admin authorization,
  - same-HWID legacy recovery does not increment `activation_count`,
  - genuine unused key is still a first claim,
  - retry after a successful activation does not consume another activation,
  - buyer/owner identity remains unchanged.
- F2:
  - service denies with `rate_limited` when the key/session bucket is exceeded,
  - bucket values are server-side ids, not plaintext credentials,
  - spoofed `x-key-fingerprint` and bearer headers cannot change route dimensions.
- F3:
  - active session revoke,
  - repeated revoke,
  - superseded session revoke writes no new audit,
  - another key's active session stays active,
  - key status and buyer identity remain unchanged.
- F4:
  - existing version 1 key verification through the executor path,
  - new keys are written as version 2,
  - production refuses to load without `KEY_HMAC_SECRET`,
  - non-`v2` version with a dedicated secret is rejected,
  - web-session compatibility is covered by the unchanged Phase 4 tests.
- F5:
  - real-PostgreSQL activation, HWID, nonce, entitlement, and one-active-session tests.

## 6. Verification results

| Command | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit` exited 0. |
| `npm run lint` | PASS | `eslint .` exited 0. |
| `npm run format:check` | PASS | Prettier reported all files formatted. |
| `npm test` | PASS | 31 test files, 317 tests passed. |
| `npm run build` | PASS | Next.js production build completed with `NEXT_PUBLIC_SITE_URL=https://boyfinity.example`; the build requires an https URL in production. |
| `npm run test:integration:concurrency` | NOT RUN | 2 test files / 5 tests skipped because `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL` is not set. No real-PostgreSQL result is claimed. |

## 7. PostgreSQL concurrency status

**NOT RUN.** The dedicated real test database was not available in this environment. The suite is implemented and gated on `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL`; it refuses any database whose name is not `boyfinity_concurrency_test` and never falls back to `DATABASE_URL`. It must be run by an operator with an isolated test database:

```text
npm run db:migrate:test
npm run test:integration:concurrency
```

## 8. Legacy key migration implications

- No automatic conversion of Discord-claimed keys to executor claims.
- A legacy key with a matching HWID can recover as a reactivation without consuming an activation and without changing its `discord` claim kind.
- A legacy key with no HWID is ambiguous and is denied until an admin calls `POST /api/admin/keys/:id/executor-claim` with a reason. That action is audited and does not alter buyer identity.
- Migration `0003_executor_review_fixes.sql` is additive. It adds the authorization columns and marks legacy claim evidence as `discord` where the claim kind was null. It does not delete or rewrite ownership.
- Existing version 1 key hashes remain readable through `SESSION_HMAC_SECRET`. No plaintext key reissue or hash rewrite is performed by this change.

## 9. Required environment configuration names

Never commit values. Only names and required shapes are listed.

| Name | Requirement |
|---|---|
| `KEY_HMAC_SECRET` | Required in production; dedicated secret for key, executor-token, and nonce hashing. Keep it stable. |
| `KEY_HMAC_KEY_VERSION` | Must be `v2` when `KEY_HMAC_SECRET` is set. |
| `SESSION_HMAC_SECRET` | Keep configured while legacy version 1 key hashes must remain verifiable. Also protects existing web/Discord sessions. |
| `RATE_LIMIT_HMAC_SECRET` | Required in production for rate-limit bucket identifiers. |
| `HWID_HASH_SECRET` | Required in production; keep stable or every stored device binding becomes invalid. |
| `BOYFINITY_CONCURRENCY_TEST_DATABASE_URL` | Only for the isolated real-PostgreSQL suite; database name must be `boyfinity_concurrency_test`. |
| `NEXT_PUBLIC_SITE_URL` | Production build requires an `https://` URL. |

Operator migration order:

1. Generate a dedicated `KEY_HMAC_SECRET` and set `KEY_HMAC_KEY_VERSION=v2`.
2. Keep `SESSION_HMAC_SECRET` unchanged.
3. Deploy and verify existing version 1 keys still activate/validate.
4. Only after verifying legacy coverage, decide whether to reissue or retire legacy keys. This change does not do that automatically.

## 10. Remaining risks and manual steps

- **Real PostgreSQL proof is still outstanding.** The new suite has not run against a real database in this environment. This is the main remaining verification gap.
- **Legacy null-HWID keys require operator action.** They are intentionally not self-service recoverable.
- **Reverse-proxy trust is deployment-specific.** If the app is exposed without a trusted proxy, `x-forwarded-for`/`x-real-ip` are spoofable; the IP bucket then only raises the cost of abuse.
- **`SESSION_HMAC_SECRET` remains required for legacy reads.** Removing it before legacy keys are retired will make version 1 keys unverifiable.
- **No production migration was run.** Migration `0003` must be reviewed and applied by an operator in the normal deployment process.
- **No merge or deploy was performed.** The branch remains a feature branch.
