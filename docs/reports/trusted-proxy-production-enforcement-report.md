# F3 — Trusted proxy production enforcement report

## Baseline

- Base branch: `fix/pre-merge-security-hardening`
- Base commit: `bfe429bf8c8b12bb5abf319dbb57e0082dd5bb87`
- Working tree at audit start: clean
- New working branch: `fix/trusted-proxy-production-enforcement`
- No reset, forced checkout, stash, or user-change discard was used.

## Findings

1. **Production did not fail closed without `TRUSTED_PROXY_SECRET`.**
   The environment schema treated the secret as optional in every environment.
   Production therefore started with no trusted IP source and silently omitted
   IP rate-limit buckets.

2. **Some public routes could lose every rate-limit dimension.**
   `/api/auth/login` and `/api/auth/callback` had only an IP bucket.
   `/api/executor/v1/activate`, `/validate`, and `/session/revoke` had a route IP
   bucket plus service-level buckets only after a key or session was identified.
   A direct caller without a valid proxy marker could therefore avoid the route
   IP bucket, and an unknown key/session had no service bucket either. This was
   an unthrottled path, not merely a weak IP bucket.

3. **The existing IP parser already met the F3 contract.**
   It required the server-side marker, compared it in constant time through
   SHA-256 digests, required exactly one IPv4/IPv6 address, ignored
   `x-real-ip`, rejected malformed/list values, and returned `null` instead of a
   shared `"unknown"` bucket. These behaviors were retained.

4. **Production detection had to stay lazy.**
   Resolving production at handler construction made `next build` page-data
   collection demand runtime secrets. Production detection now happens on the
   first request, so the build remains secret-free while runtime still fails
   closed.

## Minimal changes

- `src/core/env.ts`
  - `TRUSTED_PROXY_SECRET` is now required when `NODE_ENV=production`.
  - Development and test still load without it.
  - The existing minimum length and empty-value handling remain unchanged.
- `src/http/app.ts`
  - Production is resolved lazily per request.
  - If a rate-limited route produces no dimension in production, the pipeline
    returns `403 forbidden` before the handler or limiter work. This is
    fail-closed and avoids inventing a shared `"unknown"` bucket.
  - Routes that still have a server-derived user or key/session dimension keep
    running and remain throttled.
- `.env.example`, `docs/setup.md`
  - Document the production requirement and the fail-closed behavior.
- Tests
  - Added production/development/test environment coverage, marker and IP
    coverage, endpoint dimension coverage, and production rejection coverage.

## Public endpoint analysis

| Endpoint | Without verified IP | Protection |
|---|---|---|
| `GET /api/auth/login` | Production: `403` before handler. Dev/test: no IP bucket; no `"unknown"` bucket. | IP bucket when marker + one valid address are present. |
| `GET /api/auth/callback` | Production: `403` before handler. Dev/test: no IP bucket; no `"unknown"` bucket. | Same as login. |
| `POST /api/keys/activate` | Server-derived user bucket remains. | User bucket always for a session; IP bucket added only with a verified address. |
| `POST /api/keys/validate` | Server-derived user bucket remains. | Same, with the higher validation limits. |
| `POST /api/executor/v1/activate` | Production: `403` before body parsing and key lookup. | Verified IP bucket at the route; per-key bucket in the service once the key exists. |
| `POST /api/executor/v1/validate` | Production: `403` before body parsing and session lookup. | Verified IP bucket at the route; per-session bucket in the service once the session exists. |
| `POST /api/executor/v1/session/revoke` | Production: `403` before body parsing and session lookup. | Verified IP bucket at the route; per-session bucket in the service once the session exists. |
| Authenticated key endpoints (user bucket) | Allowed only with the existing session; user bucket still applies. | Server-derived user bucket; IP bucket is optional. |

No endpoint uses an `"unknown"` IP bucket. No endpoint uses `x-real-ip`.

## Changed files

| File | Reason |
|---|---|
| `src/core/env.ts` | Require `TRUSTED_PROXY_SECRET` in production; keep dev/test optional. |
| `src/http/app.ts` | Lazy production check and fail-closed rejection when no trustworthy rate-limit dimension exists. |
| `.env.example` | Correct the production requirement and document the missing-secret behavior. |
| `docs/setup.md` | Correct the environment table and rate-limiting contract. |
| `test/env.test.ts` | Production missing/invalid/valid secret, dev/test without secret, no secret echo. Added the proxy secret to production fixtures that were testing other secrets. |
| `test/auth-config.test.ts` | Production fixture now includes the required proxy secret so the existing session-secret assertion still targets `SESSION_HMAC_SECRET`. |
| `test/trusted-proxy-production.test.ts` | Production rejection, valid/invalid marker, unknown-key no-lookup, endpoint dimensions, user-only fallback, IPv6 and no `"unknown"` assertions. |

F1 and F2 source, behavior, migrations, and their tests were not changed.

## Quality gates (actual results)

Environment: Windows, local PostgreSQL 18 service. The concurrency suite used
only `TEST_DATABASE_URL` pointing at the dedicated `boyfinity_concurrency_test`
database. No production database was used.

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run format:check` | PASS |
| `npm test` | PASS — 36 files, 374 tests |
| `npm run test:integration:concurrency` | PASS — 3 files, 32 tests (real PostgreSQL) |
| `npm run build` | PASS — Next.js production build; `NEXT_PUBLIC_SITE_URL` set to a placeholder for the build only |

The test migration runner checked/applied migrations `0001`–`0004` against the
test database. No production migration was run.

## Remaining risks

- **BLOCKED — provider-specific proxy configuration:** the repository contains
  no Vercel, Cloudflare, nginx, or other proxy configuration. The real deployment
  must strip client-supplied `x-boyfinity-proxy-secret`, overwrite
  `x-forwarded-for` with exactly one client address, strip or overwrite
  `x-real-ip`, and inject the server-only marker. No provider configuration was
  invented.
- **BLOCKED — deployment topology validation:** this report cannot prove that a
  future hosting provider sanitizes forwarded headers. That requires deployment
  evidence outside this repository.
- **NOT TESTED — live provider behavior:** header rewriting was tested at the
  application boundary, not against a real Vercel/Cloudflare/nginx hop.
- **Known operational effect:** in production, a rate-limited route with no
  verified IP and no other trustworthy dimension now returns `403` until the
  proxy contract is configured. This is intentional fail-closed behavior, not a
  fallback that silently disables throttling.
- No shared fallback bucket was added because any such bucket would require a
  deployment-specific traffic limit and could let one caller deny service to
  everyone else.

## Safety confirmation

- F1 was not modified.
- F2 was not modified.
- No authentication, entitlement, database, or executor architecture was
  changed outside F3.
- No UI or product feature was changed.
- No production migration, deployment, or merge was performed.
- Only the F3 branch will be pushed; the feature and pre-merge branches were not
  modified.
