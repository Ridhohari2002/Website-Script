# Executor-First Architecture — PostgreSQL Lock Ordering & Concurrency Review Report

**Date:** 2026-11-13
**Branch:** `feat/executor-first-license-architecture`
**Initial commit:** `0a708e290c2ed000db7ff41e9049e1b14cacbb55`
**Scope:** prevent executor deadlocks by enforcing one lock order, prove the behaviour against a real PostgreSQL server, and record the verification honestly. No merge, deploy, or production migration was performed.

## 1. Root cause

`activate()` locked `keys` first and then `executor_sessions`. `validate()` did the
opposite: it locked the `executor_sessions` row via `session_token_hash` first and
only then locked the matching `keys` row. A concurrent activation and validation
on the same key could therefore hold each other's next lock:

```text
T1 activate : keys(key)                 -> waits for executor_sessions(session)
T2 validate : executor_sessions(session) -> waits for keys(key)
```

`revokeSession()` and `adminRevokeSession()` also started from
`executor_sessions`, so revocation could join the same cycle on a different
interleaving. Adding a retry would hide the cycle without removing it and could
replay nonce or audit work, so the ordering itself had to change.

## 2. Lock order before and after

| Transaction | Before | After |
|---|---|---|
| `activate()` | `keys` → `key_entitlements` (read) → `executor_sessions` | unchanged: `keys` → `key_entitlements` (share read) → `executor_sessions` |
| `validate()` | `executor_sessions` (lock) → `keys` (lock) → `key_entitlements` (plain read) | `executor_sessions` (unlocked projection) → `keys` (lock) → `executor_sessions` (lock/re-read) → `key_entitlements` (share lock) |
| `revokeSession()` | `executor_sessions` (lock) | `executor_sessions` (unlocked projection) → `keys` (lock) → `executor_sessions` (lock/re-read) |
| `adminRevokeSession()` | `executor_sessions` (lock) | `keys` (lock) → `executor_sessions` (lock/re-read) |
| `KeyService.adminRevoke()` / `adminResetHwid()` | `keys` → `key_sessions`/`executor_sessions` updates | unchanged: `keys` → session updates |
| `resolveScriptAccess()` | entitlement rows read without a row lock | `key_entitlements` read with `FOR SHARE OF ke` |

The unlock order is now uniform for every transaction that touches a key and an
executor session: **`keys` first, `executor_sessions` second**.

The initial session lookup in `validate()` and `revokeSession()` is an unlocked
projection used only to learn `key_id`. No authorization decision is made from
that row. After the key lock is acquired, the session is read again by primary
key and `key_id`, and every status, expiry, HWID, entitlement, ownership, and
nonce check runs against the re-read row.

## 3. Transaction changes

### `validate()`

- Replaced the locking `where session_token_hash = any(...) for update` lookup
  with an unlocked `select id, key_id` projection.
- Locked `keys` by the projected `key_id`.
- Re-read and locked the session with `where id = $1 and key_id = $2 for update`.
- Kept all existing checks in their original order: session status, absolute
  expiry, idle expiry, terminal key status, key expiry, session HWID, key HWID,
  timestamp window, script access, nonce uniqueness, idle refresh, grant and
  audit.
- A session that disappears between the unlocked projection and the lock is
  denied as `session_required`; it is never authorized from stale data.

### `revokeSession()`

- Same unlocked projection → `keys` lock → session lock/re-read sequence.
- Status outcomes (`already_revoked`, `superseded`, `expired`, `revoked`) still
  come from the re-read row.
- The conditional `update ... where status = 'active'` remains the final
  authority, so a concurrent transition cannot produce a second revocation
  event or audit row.

### `adminRevokeSession()`

- Locks the supplied `keys` row first, then the session by `id` and `key_id`.
- A missing key or session still returns `Session not found`.
- The session status is re-read under the lock before the update and audit.

### `resolveScriptAccess()`

- Added `for share of ke` to the entitlement query. A concurrent entitlement
  revocation/suspension now either commits before the read (validation sees the
  revoked row) or waits until the grant transaction commits. It cannot commit
  between the read and the grant.
- Entitlement locks are only taken after the key lock, so entitlement writers
  cannot invert the `keys` → `executor_sessions` order.

### Retry policy

No `40P01`/`40001` retry was added. The single ordering removes the only
observed lock cycle. Retrying would re-run nonce insertion and audit effects
inside the same logical operation and risks duplicate effects unless every
effect were made idempotent; that is a larger change than this fix needs. If a
future path introduces a new multi-row lock set, the fix must be another
deterministic order, not a blanket retry.

## 4. Changed files

| File | Change |
|---|---|
| `src/modules/executor/service.ts` | Key-first locking in `validate()`, `revokeSession()`, and `adminRevokeSession()`; re-read session before authorization. |
| `src/modules/access/script-access.ts` | `FOR SHARE OF ke` on the entitlement read. |
| `test/integration/executor-concurrency.integration.ts` | Real-PostgreSQL scenarios A–H with five iterations each and fixture-scoped cleanup. |
| `test/helpers/pg-db.ts` | Test database variable renamed to `TEST_DATABASE_URL`; safety checks retained. |
| `scripts/migrate-test.ts` | Test-only migration runner reads only `TEST_DATABASE_URL`. |
| `.env.example` | Documents `TEST_DATABASE_URL`. |
| `docs/setup.md` | Updated commands and added an isolated Docker PostgreSQL option. |

## 5. Real PostgreSQL integration suite

The suite uses `pg.Pool` against a real PostgreSQL server, not PGlite. PGlite
serializes transactions in-process and cannot demonstrate row-lock contention.

Safety properties retained:

- Only `TEST_DATABASE_URL` is read; there is no fallback to `DATABASE_URL`.
- The URL must use `postgres:`/`postgresql:`.
- The URL's database name and the connected `current_database()` must both be
  exactly `boyfinity_concurrency_test`.
- A URL identical to `DATABASE_URL` is rejected.
- No `DROP DATABASE`, `DROP SCHEMA`, or shared-table truncate is used.
- Every fixture uses UUID-scoped users, scripts, products, keys, and
  entitlements; cleanup deletes only those records.
- Migrations are checked before any fixture write.
- The suite also verifies `executor_sessions_one_active_per_key` and
  `executor_nonces_hash_key` exist.

### Scenarios and iterations

Each scenario ran **5 iterations** (40 executor scenario iterations total).

| ID | Scenario | Assertions |
|---|---|---|
| A | Activation vs validation on an existing active session | No deadlock; exactly one active session; the final active session is the new activation; validation either grants against the old session before replacement or is denied `session_revoked`. |
| B | Two same-HWID activations | Both complete; exactly one active session; `activation_count` remains 1. |
| C | Two different-HWID activations | Exactly one binding succeeds; the loser is `hwid_mismatch`; stored HWID hash matches the winner; owner identity is unchanged; one active session. |
| D | Validation vs revoke | Revoke succeeds; final session is `revoked`; validation either granted once or was denied `session_revoked`; at most one nonce and exactly one revoke audit; a later validation is denied. |
| E | Admin revoke vs activation | Admin revoke returns `revoked` or `superseded`; activation creates the only active session; owner Discord id and user id are unchanged. |
| F | Entitlement revocation vs validation | Entitlement ends `revoked`; validation either granted before the revocation commit or was denied `entitlement_suspended`; a grant can never be logged after the revocation commit; a later validation is denied. |
| G | Concurrent nonce reuse | Exactly one request succeeds, the other is `replay_detected`; exactly one nonce and one grant row. |
| H | Four concurrent activations | All complete; exactly one active session; `activation_count` remains 1; all four session rows are present. |

The existing real-PostgreSQL auth session-cap test also ran in the same
integration invocation.

## 6. Verification results

| Check | Status | Evidence |
|---|---|---|
| Typecheck | **PASS** | `npm run typecheck` (`tsc --noEmit`) exited 0. |
| Lint | **PASS** | `npm run lint` (`eslint .`) exited 0. |
| Format check | **PASS** | `npm run format:check` reported all files use Prettier style. |
| Full test suite | **PASS** | `npm test`: 31 files, 317 tests passed. |
| Production build | **PASS** | `NEXT_PUBLIC_SITE_URL=https://boyfinity.example npm run build`; Next.js 16.4.6 compiled and generated 17 static pages. |
| Test migrations | **PASS** | `npm run db:migrate:test` applied `0001`, `0002`, `0003` to the isolated test database. |
| Real-PostgreSQL concurrency suite | **PASS** | `npm run test:integration:concurrency`: 2 files, 9 tests passed (8 executor scenarios × 5 iterations + 1 auth concurrency test), 6.32 s. |

Transparency note: the first `npm test` run was launched in parallel with lint
and format checks and one unrelated auth HTTP test hit its 5-second timeout.
That file passed alone (20/20), and the full suite was rerun alone and passed
317/317. The recorded result is the isolated rerun. No test was changed to make
it pass.

## 7. Real-PostgreSQL evidence

- Server: PostgreSQL **18.6**, x86_64-windows.
- Instance: an isolated temporary cluster created with the installed
  `initdb`, reached only on `localhost:55432`. No existing development or
  production database was used.
- Database: `boyfinity_concurrency_test`, confirmed with
  `current_database()`.
- Schema: 36 public tables; `schema_migrations` recorded `0001_init.sql`,
  `0002_executor_first.sql`, and `0003_executor_review_fixes.sql`.
- Transport: `pg.Pool` with real `BEGIN`/`COMMIT` transactions and independent
  connections, application name `boyfinity-concurrency-test`.
- The test command was:
  `TEST_DATABASE_URL=postgresql://postgres@localhost:55432/boyfinity_concurrency_test npm run test:integration:concurrency`
  (set as a PowerShell environment variable; the credential-free trust auth was
  limited to the temporary local cluster).

## 8. Invariants rechecked

- `executor_sessions_one_active_per_key` remains present and is asserted by the
  schema check and scenario H.
- `executor_nonces_hash_key` remains present and scenario G proves PostgreSQL
  rejects the second nonce.
- Buyer identity columns (`user_id`, `owner_discord_id`) are never written by
  activation, validation, or revoke; scenario E asserts they are unchanged.
- No raw key, HWID, or session token is added to logs or audit metadata.
- Audit actions remain `executor.activate`, `executor.validate`,
  `executor.session_revoke`, and `executor.session_revoke_admin`; scenario D
  asserts exactly one revoke audit under contention.
- Superseded sessions remain unusable (scenario A validation of the replaced
  session is denied).
- Idle timeout (30 minutes) and absolute timeout (24 hours) are unchanged and
  are still re-evaluated after the key and session locks are held.
- Discord OAuth/session behaviour was not modified; its real-PostgreSQL suite
  still passes.
- No API contract changed.

## 9. Limitations

1. The repository has no product-facing entitlement-revocation endpoint yet.
   Scenario F drives the revocation as a direct `key_entitlements` update. The
   `FOR SHARE` lock is what makes that write serialize with validation.
2. No automatic deadlock/serialization retry exists. This is deliberate; the
   consistent order removes the known cycle and avoids duplicate nonce/audit
   effects. A future multi-row transaction must preserve `keys` before
   `executor_sessions`.
3. The suite ran for five iterations per scenario, not as a long soak test. CI
   should run the same suite against a managed PostgreSQL service.
4. Evidence comes from a temporary local PostgreSQL 18.6 cluster. It is a real
   server, but not a CI service; the test database remains operator-provided via
   `TEST_DATABASE_URL`.

## 10. Final-review readiness

The known deadlock cycle is removed at its source, every executor transaction
now follows `keys` → `executor_sessions`, entitlement reads are protected by a
share lock, and all scenarios A–H passed against real PostgreSQL. The code and
tests are ready for final review on
`feat/executor-first-license-architecture`.

No merge to `main`, deployment, production environment change, or production
migration was performed.
