# Pre-merge security hardening report (F1–F3)

## Branch and baseline

- Base branch: `feat/executor-first-license-architecture`
- Base commit: `b6bd511e3fbfed2a73a07b429f26968d51fe1352`
- Working branch: `fix/pre-merge-security-hardening`
- The branch was created from the latest verified feature HEAD with a clean
  working tree and a local/remote match. `main` and the feature branch were not
  modified.

## F1 — Serialize entitlement eligibility

### Finding

`resolveScriptAccess()` resolved eligibility with two reads. The script read had
no lock, and the entitlement join used `for share of ke` only. A concurrent
product deactivation, `product_scripts` deletion, script unpublish, or
entitlement revocation could commit between those reads and the grant insert.
PostgreSQL would then grant access based on state that had already changed.

### Root cause

Row-level locking covered only `key_entitlements`. The other rows that decide
eligibility (`scripts`, `products`, `product_scripts`) were read without a lock,
so their committed changes were not serialized against the validation
transaction.

### Fix

`src/modules/access/script-access.ts`:

- the eligible script read now ends with `for share of s`;
- the entitlement join now ends with `for share of ke, p, ps`.

The existing global lock order is preserved: `keys` is locked first, then
`executor_sessions`, then entitlement-related rows. No business rule changed:
suspended/revoked entitlements are still denied, inactive products are denied,
missing mappings grant nothing, the legacy product has no automatic script
access, and there is still no fallback to all published scripts.

### Deterministic tests

Added to `test/integration/executor-concurrency.integration.ts` using blocker
connections, `pg_stat_activity`/`pg_blocking_pids`, and a transaction-scoped
advisory-lock trigger:

- **F1-A** — validation waits on the product share lock; after the blocker
  commits `products.active = false`, validation is denied with
  `product_inactive`.
- **F1-B** — validation waits on the mapping share lock; after the blocker
  commits the `product_scripts` deletion, validation is denied with
  `entitlement_missing`.
- **F1-C** — validation waits on the script share lock; after the blocker
  commits `scripts.status = 'draft'`, validation is denied with
  `script_not_found`.
- **F1-D** — validation holds the share locks first. A trigger pauses it at the
  grant insert with an advisory lock; an admin product update then waits on the
  validation share lock. Validation commits a grant, the admin update applies
  afterwards, and buyer identity is unchanged.

Each test asserts no grant after the committed access change, no nonce consumed
by a denied validation, no deadlock (`40P01`), and no buyer identity mutation.

## F2 — Safe payment default

### Finding

`key_purchases.payment_status` defaulted to `paid`. Any future checkout that
inserted a purchase before server-side verification would create a record that
already looked paid.

### Root cause

The original schema default encoded the successful end state instead of the
initial state.

### Fix

New migration: `supabase/migrations/0004_payment_status_default.sql`.

- Changes the default to `pending`.
- Does not update existing rows.
- Keeps the existing allowed set: `pending`, `paid`, `failed`, `refunded`,
  `free`, `legacy`.
- The existing legacy backfill still writes an explicit `legacy` value.
- No payment provider or webhook was added or changed. No payment-writing code
  exists yet; a future verified process must set `paid` explicitly.

`test/payment-status-migration.test.ts` applies migrations in order, seeds an
existing `paid` row before `0004`, then proves: an insert without
`payment_status` becomes `pending`; explicit `legacy` remains valid; `paid` is
not automatic; the pre-existing row is unchanged; an unknown status is still
rejected.

## F3 — Trusted reverse proxy and client IP

### Finding

`clientIp()` trusted `x-forwarded-for` and then `x-real-ip` without any proof
that the request passed through a trusted proxy. A client could choose its own
rate-limit bucket, or produce an audit IP, by sending those headers directly.

### Deployment evidence inspected

- `docs/setup.md` states the project is local-only: no deployment, hosting, or
  production Discord application is configured.
- `BACKEND.md` names Vercel Hobby as a future runtime target, but the repository
  contains no Vercel, Cloudflare, nginx, or other proxy configuration that could
  prove forwarded headers are sanitized.
- No infrastructure exists in this repository that can be claimed as a trusted
  proxy.

### Root cause

Header presence was treated as proof of a trusted hop. There was no shared
server-side marker, no proxy contract, and no fail-closed path when forwarding
headers were untrusted.

### Fix

`src/core/request-meta.ts` now:

- requires `TRUSTED_PROXY_SECRET` to be configured;
- requires the proxy marker header `x-boyfinity-proxy-secret`;
- compares the marker to the secret in constant time using SHA-256 digests;
- requires `x-forwarded-for` to contain exactly one IPv4 or IPv6 address;
- rejects comma lists, malformed values, ports, and oversized values;
- ignores `x-real-ip` entirely;
- returns `null` when any proof is missing or invalid.

`TRUSTED_PROXY_SECRET` is server-only, optional in the environment schema, and
has **no development default** (a public default would be forgeable). When it is
absent, no IP is trusted.

Route behavior was changed so a missing verified IP does not create a shared
`"unknown"` bucket:

- `src/routes/executor.ts` omits the IP dimension;
- `src/routes/keys.ts` keeps the server-derived user dimension and omits the IP
  dimension;
- `src/routes/auth.ts` omits the IP dimension.

IP is still used only for abuse prevention and audit metadata, never for
authorization. Per-key and per-session buckets remain in force for executor
traffic.

### Tests

`test/request-meta.test.ts` proves:

- spoofed `x-forwarded-for` is untrusted without the marker;
- spoofed `x-real-ip` is untrusted;
- a valid marker accepts a single forwarded IPv4 or IPv6 address;
- an invalid marker is rejected;
- multiple forwarded addresses are rejected, so the client cannot influence
  selection;
- malformed/oversized values are safe;
- `x-real-ip` is ignored when the marker is valid.

`test/executor-route.test.ts` proves the executor route emits an IP bucket only
for a verified proxy request, omits it when the marker is missing, ignores
`x-real-ip`, rejects forwarded lists, and supports IPv6.

## Changed files

Application and configuration:

- `src/modules/access/script-access.ts`
- `src/core/request-meta.ts`
- `src/core/env.ts`
- `src/routes/executor.ts`
- `src/routes/keys.ts`
- `src/routes/auth.ts`
- `.env.example`
- `docs/setup.md`

Migration:

- `supabase/migrations/0004_payment_status_default.sql`

Tests and test infrastructure:

- `test/request-meta.test.ts`
- `test/executor-route.test.ts`
- `test/payment-status-migration.test.ts`
- `test/integration/executor-concurrency.integration.ts`
- `test/env.test.ts`
- `test/auth-oauth.test.ts`
- `test/executor.test.ts`
- `test/helpers/auth.ts`
- `test/helpers/keys.ts`
- `test/helpers/proxy.ts`
- `test/integration/api-phase6.integration.ts`
- `test/setup.ts`
- `vitest.config.ts`
- `vitest.integration.config.ts`

## Quality gates (actual results)

Environment: Windows, Node/npm per repository, temporary local PostgreSQL 18
cluster on `localhost:55432`, database `boyfinity_concurrency_test`. Only
`TEST_DATABASE_URL` was used; the guard rejected any fallback to `DATABASE_URL`.

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm test` | PASS — 35 files, 359 tests |
| `npm run test:integration:concurrency` | PASS — 3 files, 32 tests (real PostgreSQL) |
| `npm run build` | PASS — Next.js production build; `NEXT_PUBLIC_SITE_URL` set to a placeholder for the build only |

The test migration runner applied `0001`–`0004` to the temporary test database.
No production database, production migration, deployment, or merge was run.

## Unresolved limitations and required proxy configuration

- **No reverse proxy is configured or proven in this repository.** Until one is,
  IP rate limiting is inactive, not merely weak. The deployment must configure
  a trusted proxy before production if IP-level abuse protection is required.
- The proxy must:
  1. remove any client-supplied `x-boyfinity-proxy-secret`;
  2. remove or overwrite any client-supplied `x-forwarded-for`;
  3. overwrite `x-forwarded-for` with exactly one client address;
  4. remove or overwrite `x-real-ip` (the application ignores it);
  5. inject `x-boyfinity-proxy-secret` with the server-only
     `TRUSTED_PROXY_SECRET` value.
- If the proxy cannot satisfy that contract, leave `TRUSTED_PROXY_SECRET` unset.
  The application will keep IP rate limiting off and rely on the per-user,
  per-key, and per-session buckets.
- Header-derived IP remains audit/abuse metadata only, never authorization.
- `BACKEND.md` still names Vercel Hobby as a future target. That is a documented
  intention, not evidence that forwarded headers are sanitized; the Vercel
  topology must be reviewed and configured before this trust boundary can be
  considered active in production.
- No payment provider/webhook was implemented, by design.

## Production safety confirmation

- No production migration was applied.
- No production environment or secret was changed.
- No deploy or merge was performed.
- Only the temporary local test PostgreSQL cluster was used and it was stopped
  and removed after verification.
