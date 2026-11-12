# Phase 4 Implementation Report — Key Lifecycle and Validation

**Date:** 2026-11-12
**Baseline:** `871bf63 feat(auth): add primary Discord owner identity`
**Scope:** `IMPLEMENTATION_PLAN.md` §8.6 only. Phase 5 was not started.

## 1. Scope and Decisions

Phase 4 implements the key lifecycle: generation, activation, validation, key sessions, HWID binding and reset, owner/admin key controls, access orchestration, and terminal status gates.

Two previously unapproved decisions were resolved before implementation:

- **D5 — HWID source and normalization:** owner approved the versioned `v1` scheme. NFKC, trim, lowercase, remove common separators (`whitespace`, `-`, `_`, `.`, `:`, `/`, `\`), require 8–128 characters, then HMAC-SHA-256 with `HWID_HASH_SECRET`. `hwid` is optional; device binding is skipped when it is absent, matching `BACKEND.md` §9.13.
- **D18 — Roblox integration credentials:** owner directed that per-place credentials, timestamp/nonce HMAC signing, and replay storage are deferred to a later phase. Phase 4 authorizes on account session + key session + script eligibility only. The gap is recorded in §8.

No database migration was added. The existing `0001_init.sql` already contains `keys`, `key_sessions`, `key_device_history`, `key_hwid_resets`, `key_reactivations`, `idempotency_keys`, `rate_limit_counters`, `script_access_logs`, `system_settings`, and `audit_logs`.

## 2. Files Changed

### New source files

- `src/core/crypto/hwid.ts` — D5 v1 normalization, keyed hash, short fingerprint.
- `src/modules/keys/crypto.ts` — plaintext key generation, display prefix, key hash, key-session token hash.
- `src/modules/keys/errors.ts` — stable key denial codes with generic external messages.
- `src/modules/keys/audit.ts` — key lifecycle audit actions and durable insert.
- `src/modules/keys/service.ts` — lifecycle service: generation, activation, validation, reset, owner/admin reads, status gates, locking, idempotency, audit.
- `src/modules/access/script-access.ts` — script eligibility lookup by `scripts.public_id`.
- `src/validators/keys.ts` — Zod schemas, required `Idempotency-Key`, bearer-token parsing.
- `src/routes/keys.ts` — HTTP translation for the Phase 4 endpoints.

### Modified source files

- `src/core/env.ts` — added optional `HWID_HASH_SECRET` and lazy `getHwidSecret()` (production refuses to run without it).
- `src/core/errors.ts` — added stable key error codes.
- `src/db/idempotency.ts` — added an injectable transaction runner so the same D10 store works with the embedded test database; production still uses one `pg` transaction.
- `src/routes/index.ts` — registers key routes and allows a test-injected `KeyService`.
- `.env.example` — documented `HWID_HASH_SECRET`.

### Tests

- `test/hwid.test.ts` — normalization, versioning, length bounds, alphabet, deterministic keyed hash, fingerprint.
- `test/keys-unit.test.ts` — key format/entropy/prefix, domain-separated hashing, status precedence.
- `test/keys-service.test.ts` — integration against the embedded PostgreSQL build.
- `test/keys-http.test.ts` — route-level activation/validation/CSRF/idempotency/admin checks.
- `test/helpers/keys.ts` — shared test users, sessions, script seeding, fixed test secrets.
- `test/helpers/http.ts` — optional `KeyService` injection.
- `test/env.test.ts` — `HWID_HASH_SECRET` accessor and production failure mode.

## 3. Implementation Details

### Key generation

- Plaintext keys are `bf_` plus 32 CSPRNG bytes as 64 hex characters (256 bits).
- Only the keyed HMAC-SHA-256 hash and an 11-character display prefix are stored.
- Plaintext is returned exactly once in the creation response and never logged.
- Bulk generation is capped at 100 keys per request.

### Activation

- One transaction locks the key row `FOR UPDATE`.
- `banned` and `revoked` are terminal denies. `suspended` is allowed only when an unused `key_reactivations` row exists; consumption is a conditional `UPDATE ... WHERE consumed_at IS NULL`.
- A different owner is denied as `already_owned`; an already-active key is denied as `already_owned`.
- Expiry and activation cap are checked before mutation.
- Any existing active key session is superseded, then one new active session is created.
- The key session token is returned once; the idempotency store persists only the safe body.
- `key_device_history` is written when a device is bound.
- Audit actions: `key.activate`, `key.ban_reactivation_consumed`, `key.activate_failed`.

### Validation

The nine-step flow is implemented server-side in this order:

1. Body/schema validation and route rate limiting.
2. Key hash lookup.
3. Ownership from the server session, never client input.
4. Terminal status precedence: `banned` → `revoked` → `suspended` → not active.
5. Key expiry and subscription `active`/`expires_at` checks.
6. HWID comparison only when a trustworthy value is supplied; mismatch records `validation_failed`.
7. Key-session existence, status, key/user match, absolute expiry, revocation, and idle window.
8. Script eligibility (published, enabled, not soft-deleted).
9. Grant insertion into `script_access_logs` with a 60-second retry dedupe window, then `last_seen_at` touch and audit.

Denations return a stable code with a generic message. The precise reason is written to `audit_logs` after the transaction rolls back, so the audit row survives.

### HWID reset

- Self-service reset requires ownership, `Idempotency-Key`, and route rate limiting.
- Cooldown defaults to 24 hours; cap defaults to 3 resets. Both are read from `system_settings` (`hwid.reset_cooldown_hours`, `hwid.max_resets`).
- A reset clears the binding, increments the counter, revokes active key sessions, and writes `key_hwid_resets`, `key_device_history`, and `audit_logs`.
- Admin reset bypasses the user cooldown/cap but still refuses `banned` and non-active keys; it records the admin actor and reason.

### Owner and admin controls

- Owner list, usage, and device history are scoped by `owner_discord_id` from the server session.
- Device history returns short fingerprints only, never a raw HWID.
- Admin routes use the existing `access: "admin"` pipeline gate, which accepts the derived `owner` role through `hasAdminAccess`.
- Admin revoke, reset, list, and device history write audit rows.

### Access orchestration

`resolveScriptAccess` reads `scripts` by `public_id` and requires `status = 'published'`, `enabled = true`, and `deleted_at IS NULL`.

## 4. Security Review

- Ownership comes only from the server-resolved session. No route reads a Discord ID, role, owner, or expiry from the request body.
- Plaintext keys are never stored after generation; the database holds a keyed hash and display prefix.
- Raw HWIDs are never stored, returned, or logged. Only keyed hashes and 12-character fingerprints exist.
- Activation and reset are idempotent and rate-limited; activation locks the key row and creates the session in the same transaction.
- A new activation supersedes the old session; admin revoke and HWID reset revoke immediately.
- Terminal status is evaluated before expiry and subscription checks.
- Denial audit rows are written after rollback, so a rejected transaction cannot erase the evidence.
- The build does not require runtime secrets: key secrets are resolved lazily, preserving the existing `next build` contract.
- No `.env.local` value was printed, read into output, or committed.

## 5. Verification and Actual Results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | PASS |
| Lint | `npm run lint` | PASS |
| Format | `npm run format:check` | PASS |
| Tests | `npm test` | PASS — 29 files, 283 tests |
| Build | `NEXT_PUBLIC_SITE_URL=https://boyfinity.example npm run build` | PASS |
| Runtime health | `GET /api/health` on `next start` | `503` with `database: "down"` (no local PostgreSQL reachable) |
| Runtime auth gate | `GET /api/keys/me` on `next start` | `401 unauthorized` as expected |

Build note: the first build attempt failed because `NEXT_PUBLIC_SITE_URL` is not set in the local environment. That is an existing site-configuration requirement, not a Phase 4 change. The build passed after supplying a public placeholder URL.

Runtime note: the embedded test database is used for the full suite. The real runtime check could not reach a PostgreSQL instance, so `/api/health` correctly reported degraded. No live third-party or browser test was performed, and none is claimed.

## 6. Phase 4 Endpoint Coverage

Implemented:

- `POST /api/keys/activate`
- `POST /api/keys/validate`
- `POST /api/keys/reset-hwid`
- `GET /api/keys/me`
- `GET /api/keys/{id}/usage`
- `GET /api/keys/{id}/devices`
- `POST /api/admin/keys`
- `GET /api/admin/keys`
- `POST /api/admin/keys/{id}/revoke`
- `POST /api/admin/keys/{id}/reset-hwid`
- `GET /api/admin/keys/{id}/devices`

Deferred as documented: `POST /api/keys/claim` belongs to the offers phase.

## 7. Limitations

- Phase 3 catalog APIs are not present in this repository. Validation reads `scripts` directly by `public_id`; the catalog read path will be wired to the same eligibility function in Phase 5.
- The approved schema has no key-type/plan-to-script mapping. Until Phase 5 adds one, any valid key can reach any published script. This is a product-authorization gap, not an authentication bypass.
- The `key_reactivations` row is trusted as the admin authorization record. The Phase 5 endpoint that creates it is not present; Phase 4 seeds it directly in tests.
- PGlite serializes transactions behind one mutex. The concurrency test proves the locked state transition but cannot independently prove PostgreSQL row-lock contention. The opt-in real-PostgreSQL concurrency suite was not run.
- `GET /api/admin/keys` uses a bounded filter set (status, type, owner Discord ID, limit, offset); richer admin filtering can follow in a later phase.

## 8. Remaining Risks

- **D18 deferred:** Roblox game-server credentials, signed requests with timestamp/nonce, and replay protection are not implemented. Any caller that reaches the API with a valid account session and key session token is not additionally proven to be a specific Roblox game server.
- **HWID trust:** HWID remains a soft binding and can be spoofed. It is combined with account session, single-session enforcement, and anomaly logging, not treated as identity proof.
- **Key hash secret reuse:** key values are hashed with `SESSION_HMAC_SECRET` plus a `key:v1:` domain prefix rather than a separate `KEY_HMAC_SECRET`. Rotating the session secret invalidates existing key hashes as well as sessions. A dedicated key secret is preferable before production scale.
- **Runtime database availability:** the local runtime check could not reach PostgreSQL. Production readiness still requires a live database run of the migration and endpoint smoke tests.
- **No live Discord/Roblox/browser test:** those integrations were not exercised in this phase.
