# Executor-First Architecture — Final PostgreSQL Hardening Report

**Date:** 2026-11-14
**Branch:** `feat/executor-first-license-architecture`
**Baseline commit:** `a1a8791f6b3cd386577a50e4498776a7d5b8dbb6`
**Scope:** deterministic real-PostgreSQL concurrency tests and a fail-closed test-database safety guard. No merge, deploy, production migration, or production configuration change was performed.

## 1. Previous findings

The prior review round closed the executor lock-order inversion, but two audit items remained open:

1. The concurrency suite mostly used `Promise.all()` as evidence of interleaving, so a scheduling change could turn a "concurrency" test into a sequential one without failing.
2. Integration tests and the test migration runner each validated the target database independently, only by string comparison, and both could silently skip when no test database was configured.

## 2. Changes

### 2.1 Shared fail-closed test database guard

New `scripts/test-database-guard.ts`, used by both `test/helpers/pg-db.ts` and `scripts/migrate-test.ts`:

- Reads only `TEST_DATABASE_URL`. Never falls back to `DATABASE_URL`; `DATABASE_URL` and `APP_URL` are read only for comparison.
- Rejects `NODE_ENV=production`.
- Parses the URL instead of comparing strings, and normalizes host (lowercase, trailing dot, bracketed IPv6), default port, decoded database name, decoded username, and `sslmode`.
- Requires a host, port, database, and username; refuses ambiguous targets.
- Accepts only the test allowlist (`boyfinity_concurrency_test`); a name containing `test` is not sufficient.
- Rejects wildcard hosts, production-like host segments (`prod`, `production`, `prd`, `live`), and a test host that matches a non-loopback HTTPS `APP_URL` host.
- Rejects a target whose normalized `(host, port, database)` identity equals `DATABASE_URL`, so differently formatted URLs that point at the application database are caught.
- Refuses to proceed when `DATABASE_URL` or `APP_URL` is present but unparseable.
- Never includes a password or a connection string in an error message.
- Exposes the normalized identity, not the raw URL, to callers.

`test/helpers/pg-db.ts` additionally verifies the *connected* `current_database()` and `current_user` before returning a pool or client, so a server-side redirect cannot bypass the guard. `scripts/migration-runner.ts` now accepts an expected role and verifies both database and role before any write.

### 2.2 Deterministic concurrency tests

`test/integration/executor-concurrency.integration.ts` was rewritten. Each interleaving is forced with row locks held by a separate PostgreSQL connection:

- A `withBlocker` helper opens a dedicated `pg.Client`, begins a transaction, takes the row lock, and always commits/rolls back and closes the client in `finally`.
- A separate observer connection polls `pg_stat_activity` (20 ms bounded polling, 8 s wait deadline) for a backend whose `wait_event_type = 'Lock'` and whose statement matches the expected production SQL fragment, then asserts `pg_blocking_pids()` points at the intended blocker and that the waiting backend is a different PID.
- Row-lock waits surface in `pg_locks` as ungranted `transactionid` locks with no relation, so the guarded relation is derived from the waiting statement text, which is the exact production statement. This replaced an earlier `pg_locks`/relation approach that silently matched nothing.
- Every service operation is bounded by a 20 s timeout. Launched operations are marked handled so an abandoned assertion cannot produce an unhandled rejection.
- Cleanup terminates lingering service backends and waits for quiescence before deleting only the fixture-scoped rows it created. `Pool` and `Client` objects have `error` listeners so a forced termination during cleanup does not crash the worker.
- No sleeps are used as synchronization; the only delay is bounded polling of catalog state.

### 2.3 Old lock-order regression

The old order is reproduced with two raw clients: A locks `keys` then `executor_sessions`, B locks `executor_sessions` then `keys`. The test waits until A is observably blocked, starts B, and asserts exactly one backend fails with SQLSTATE `40P01` while the other succeeds. Backends are then terminated, because a client with a blocked statement cannot issue `ROLLBACK`. The current service order is exercised separately by the activation-first and validate-first scenarios, which assert that the second transaction queues on `keys` rather than taking `executor_sessions` first, and that no `40P01` occurs.

## 3. Scenarios and results

"Coordinated transactions" counts the blocker transaction(s) plus the service transactions driven through separate pooled connections. Each scenario also asserts the final database state, not only the service response.

| # | Scenario | Coordinated transactions | Result |
|---|---|---|---|
| A1 | `activate` then `validate` on the same session; validate must queue behind the key lock and then observe the superseded session | 1 blocker + 3 service | PASS — activation wins, validation rejects `session_revoked`, exactly one active session, 0 grants, 0 nonces |
| A2 | `validate` then `activate`; validation commits first, activation replaces the session | 1 blocker + 3 service | PASS — validation grants once, activation supersedes the old session, exactly one active session |
| B | Two concurrent activations, same HWID | 1 blocker + 2 service | PASS — both succeed, exactly one active session, `activation_count = 1`, two historical sessions |
| C | Two concurrent activations, different HWIDs | 1 blocker + 2 service | PASS — exactly one succeeds, the other rejects `hwid_mismatch`, bound HWID matches the winner, buyer identity unchanged, one active session |
| D1 | `validate` first, then `revokeSession`; revoke queues on `keys` | 1 blocker + 3 service | PASS — validation grants, then the session becomes `revoked`, exactly one revoke audit event |
| D2 | `revokeSession` first, then `validate` | 1 blocker + 3 service | PASS — revoke wins, validation rejects `session_revoked`, 0 grants, 0 nonces, one revoke audit event |
| E1 | `adminRevokeSession` first, then activation | 1 blocker + 3 service | PASS — admin revoke wins, activation creates one new active session, buyer identity preserved, one admin audit event |
| E2 | Activation first, then `adminRevokeSession` | 1 blocker + 3 service | PASS — activation supersedes; admin reports `superseded` and writes no false revocation audit |
| F | In-flight entitlement revocation vs `validate` | 1 blocker (commit) + 2 service | PASS — validation blocks on `key_entitlements`, then rejects `entitlement_suspended`; no grant, no nonce; a follow-up validation also rejects |
| G | Two parallel validations replaying one nonce | 1 blocker + 3 service | PASS — exactly one succeeds, the other rejects `replay_detected`, exactly one nonce row and one grant |
| H | Four concurrent activations | 1 blocker + 4 service | PASS — all succeed serialized behind one key lock, exactly one active session, `activation_count = 1`, four historical sessions |
| I | Old session-first order under controlled locks | 1 service + 2 raw clients | PASS — exactly one `40P01`, the other completes, fixture state unchanged |

### Separate-connection evidence

Every scenario asserts distinct backend PIDs for the transactions that must interleave, e.g. blocker PID ≠ waiter PID, first waiter PID ≠ second waiter PID, and four distinct PIDs for scenario H. The observer runs on its own pooled connection, so the lock-wait evidence is not read through a connection that participates in the transaction under test.

### Non-determinism encountered and resolved

- Row-lock waits do not appear as relation locks in `pg_locks`; they are `transactionid` waits. The wait detection was corrected to read the guarded relation from the waiting statement and to use `pg_blocking_pids()` for the blocker.
- A queued waiter is reported as blocked by the earlier waiter (a soft blocker) rather than by the original holder. Assertions now accept either the original blocker or an earlier waiter in the same queue, while still asserting that no unrelated session blocks it.
- `revokeSession` locks `keys` with `select id from keys ... for update`, not `select *`; the statement matcher was corrected.
- Cleanup-time backend termination previously produced uncaught `error` events from `pg` clients; `Pool`/`Client` error listeners and tracked operation promises were added.

## 4. Test database safety guard cases

`test/test-database-guard.test.ts` (13 tests, all passing) covers:

- `TEST_DATABASE_URL` absent → fail closed with the variable name in the message.
- Malformed URL → rejected.
- Non-PostgreSQL protocol → rejected.
- Database name outside the allowlist, including `*_test` names → rejected.
- Production-like hosts (`db.prod.example.com`, `production.internal`, wildcard `0.0.0.0`) → rejected.
- `NODE_ENV=production` with an otherwise valid target → rejected.
- Same normalized target as `DATABASE_URL` expressed in different URL formats (case, protocol, password, trailing `sslmode`) → rejected.
- Same host/port with a different database name → allowed.
- Unparseable `DATABASE_URL` → rejected as unverifiable.
- Test host equal to a non-loopback HTTPS `APP_URL` host → rejected.
- Valid target exposes normalized host, port, database, username, and SSL mode.
- Missing username and unsupported `sslmode` → rejected.
- Password never appears in an error message.

Manual fail-closed checks on `npm run db:migrate:test`:

- Missing `TEST_DATABASE_URL` → refused before any SQL.
- Non-allowlisted database → refused before any SQL.
- Same normalized target as `DATABASE_URL` → refused before any SQL.

`db:migrate:test` uses the same guard and verifies the connected database and role before applying migrations. It does not drop databases or schemas, does not truncate shared tables, and the integration suites delete only fixture-scoped rows.

## 5. Auth concurrency test correction

The existing `test/integration/auth-concurrency.integration.ts` became fail-closed, and one assertion was found to be incorrect rather than flaky.

The test used a fixed clock, so every `sessions.created_at` was identical, and it asserted that the final revoked set equalled the first `loginCount - MAX_ACTIVE_SESSIONS` rows in `(created_at, id)` order. That assumption is invalid under concurrency: each login evicts the oldest *currently active* row before inserting its own session, and because UUIDs are random, a newly inserted session can itself become the oldest active row for a later login. Instrumentation confirmed that every eviction actually chose the smallest-id active session at that moment, so the service was correct and the assertion was over-specified.

The assertion is replaced with:

- The existing exact counts (all sessions, active sessions, revoked sessions, eviction audit rows).
- A deterministic tie-breaker check: after the concurrent phase, a further serialized login must revoke exactly the smallest-id active session and keep the cap at five.

The test passed six consecutive runs after the change.

## 6. Verification

Command results on the feature branch:

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm test` | PASS — 32 files, 330 tests |
| `npm run test:integration:concurrency` | PASS — 2 files, 13 tests; run three times consecutively with the same result |
| `npm run build` | PASS — compiled successfully |

Real PostgreSQL evidence:

- The suite ran against a dedicated local PostgreSQL 18.6 cluster on a non-default port, with its own `boyfinity_concurrency_test` database.
- `npm run db:migrate:test` applied `0001_init.sql`, `0002_executor_first.sql`, and `0003_executor_review_fixes.sql` to that database through the guard.
- The concurrency tests were not run against PGlite or a mock, and no production database was contacted.

## 7. Remaining risks

- The wait detection reads the guarded relation from the waiting statement text. This is exact for the current production statements, which each name one table, but a future statement that joins `keys` and `executor_sessions` would make the derived relation ambiguous. Backend PIDs and `pg_blocking_pids()` remain authoritative regardless.
- The old-order deadlock test relies on PostgreSQL's deadlock detector (default 1 s), so scenario I is slower than the others.
- `pg_blocking_pids()` reports queued waiters as soft blockers. The assertions accept an earlier waiter as a valid blocker, which proves serialization but not which individual session is the hard blocker for queues deeper than two.
- Applying migrations requires the allowlisted test database; running the integration suite therefore needs a provisioned PostgreSQL instance. When absent, the suite fails closed rather than skipping.

## 8. Merge readiness

The executor-first lock ordering (`keys` → `executor_sessions`), one active session per key, nonce replay protection, buyer identity, entitlement checks, and the `/api/executor/v1` contract are unchanged. This round only adds tests, the shared safety guard, and the guarded test migration entry point. With every verification command passing and the real-PostgreSQL suite stable across repeated runs, the branch is ready for final merge review.
