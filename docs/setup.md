# Local development and setup

Phase 1 project foundation: Next.js App Router, TypeScript, Tailwind, PostgreSQL via
`pg` + Kysely, idempotency and rate-limit infrastructure, one API entry point.

Phase 2 adds Discord OAuth 2.0 (Authorization Code + PKCE), server-side sessions,
CSRF protection, and role/permission guards. Phase 2.1 adds the five-session cap,
session management endpoints, and auth metadata retention. Everything here is
local-only: no deployment, hosting, or production Discord application is
configured.

## Requirements

- Node.js 22 or newer (developed on 24.14.1)
- npm 10 or newer (this project uses npm; pnpm is not required)
- PostgreSQL 15 or newer

## Install

```bash
npm install
```

## Environment

Copy the template and fill in only what you need locally:

```bash
cp .env.example .env.local
```

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes at runtime | `postgresql://user:pass@host:5432/db`. Not needed for `next build`. |
| `DATABASE_POOL_MAX` | No | Pool size per process, 1–100. Defaults to `10`. |
| `RATE_LIMIT_HMAC_SECRET` | Yes in production | Minimum 16 characters. A development-only default is used otherwise. |
| `RATE_LIMIT_HMAC_KEY_VERSION` | No | Defaults to `v1`. Increasing it starts a fresh namespace of buckets. |
| `SESSION_HMAC_SECRET` | Yes in production | Minimum 16 characters. Hashes session tokens and OAuth state, and derives each session's CSRF token. Rotating it revokes every session. |
| `DISCORD_CLIENT_ID` | For login | Discord application id (snowflake). Any placeholder works for tests; real login needs the real id. |
| `DISCORD_CLIENT_SECRET` | For login | Server-only. Never commit it, log it, or expose it to browser code. |
| `DISCORD_REDIRECT_URI` | For login | Must exactly equal `${APP_URL}/api/auth/callback`. |
| `DISCORD_OWNER_ID` | No | Primary owner's Discord user id (snowflake). When set, the server appends the `owner` role to that user's effective roles. Leave empty to disable. |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`. Defaults to `info`. |
| `APP_URL` | No | Defaults to `http://localhost:3000`. |
| `MIDTRANS_SERVER_KEY` | Sandbox only | Server-only. Never commit it, never expose it to browser code. |
| `MIDTRANS_CLIENT_KEY` | Sandbox only | Environment configuration, not embedded in source. |
| `MIDTRANS_IS_PRODUCTION` | No | Must remain `false`. Setting `true` is a production action and is **not authorized**. |

`MIDTRANS_IS_PRODUCTION=false` is the only approved setting. Production payment
acceptance is **NOT AUTHORIZED** and the production payment adapter is **BLOCKED**.

## Database

Create a database, then apply the reviewed SQL:

```bash
npm run db:migrate
```

The runner applies every `supabase/migrations/*.sql` file in filename order inside
a transaction and records it in `schema_migrations`. Re-running is safe; applied
files are skipped.

Phase 2 needs no new migration: `0001_init.sql` already defines `users`,
`user_roles`, `sessions`, `oauth_states`, and `audit_logs` with the required
columns and constraints.

Row Level Security is enabled on every public table with no policy, which denies
all client access by default. The server connects with a role that bypasses RLS.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server at `http://localhost:3000` |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next.js flat config) |
| `npm test` | Vitest unit and embedded-Postgres tests |
| `npm run test:integration:concurrency` | Opt-in real-PostgreSQL concurrency test |
| `npm run format` | Prettier write |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:test` | Apply migrations to the dedicated concurrency test database |
| `npm run db:retention` | Redact stale auth metadata and delete expired OAuth states |

## API

There is exactly one API entry point: `app/api/[...path]/route.ts`. Endpoints are
declared in `src/routes/index.ts`; adding a second Next.js route file under
`app/api` would create a second auth/error surface and is not allowed.

### `GET /api/health`

- `200` when the process is up and the database answers `select 1`
- `503` when the database is unreachable
- Never reports configuration values or secrets
- Not rate limited, by design

Every response carries `x-request-id`. A safe inbound request ID is echoed;
otherwise a UUID is minted.

### Authentication endpoints (`/api/auth/*`)

All seven endpoints are declared once in `src/routes/auth.ts`; there is no second
Next.js route file. Login and callback are browser navigations, so failures are
`302` redirects carrying a stable `auth_error` code, never the authorization
code, provider body, or a credential.

| Endpoint | Method | Access | Behavior |
|---|---|---|---|
| `/api/auth/login?next=/path` | `GET` | public, IP rate limited | Sets a short-lived `bf_oauth_state` cookie and redirects to Discord with state, PKCE `code_challenge` (S256), and `scope=identify`. |
| `/api/auth/callback` | `GET` | public, IP rate limited | Consumes the single-use state (bound to the browser cookie), exchanges the code with the stored verifier, fetches `/users/@me`, upserts the user by immutable Discord id, and issues a session. Unknown accounts get the `user` role only. |
| `/api/auth/session` | `GET` | session | Returns `user`, `roles`, `csrfToken`, and `expiresAt`. `401` without a valid session. |
| `/api/auth/sessions` | `GET` | session | Lists the caller's active sessions only. `cache-control: no-store`. |
| `/api/auth/sessions/:id` | `DELETE` | session + CSRF | Revokes one session owned by the caller. `404` for missing, foreign-owned, and already-revoked ids; `400` for a malformed id. |
| `/api/auth/logout` | `POST` | session + CSRF | Revokes the current session immediately and clears cookies. |
| `/api/auth/logout-all` | `POST` | session + CSRF | Revokes every active session for the user and clears cookies. |

`next` is accepted only when it is a same-origin absolute path; anything else
falls back to `/`. Login returns `503` when the Discord credentials are missing.

### Session management responses

`GET /api/auth/sessions` returns only active sessions for the authenticated user:

```json
{
  "sessions": [
    {
      "id": "c0a8012e-...",
      "current": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "lastSeenAt": "2026-01-01T12:00:00.000Z",
      "expiresAt": "2026-01-02T00:00:00.000Z",
      "absoluteExpiresAt": "2026-01-08T00:00:00.000Z",
      "device": "Chrome on Windows"
    }
  ]
}
```

The listing never includes IP addresses, raw user-agent strings, session tokens,
token hashes, CSRF secrets, or internal credentials. `device` is a bounded label
derived server-side from the stored user agent. Revoking the current session
returns cookies that clear `bf_session` and `bf_csrf`; revoking another owned
session leaves the caller signed in.

### Session policy

- Cookie `bf_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` on HTTPS
  and in production, `Max-Age=604800`. Browser JavaScript never receives the
  token.
- Only an HMAC-SHA-256 hash of the token is stored in `sessions.token_hash`.
- 7-day absolute lifetime, 24-hour idle window, token rotation after 24 hours of
  use, and `last_seen_at` touches throttled to once per minute.
- Session checks triggered by page navigation use the normal resolver and count
  as activity, so they can extend the idle window. The absolute expiry still
  caps the total session lifetime.
- At most **five active sessions** per Discord user. Active means not revoked and
  neither idle- nor absolutely expired. A sixth login revokes the oldest active
  session first (`created_at ASC`, then `id ASC`) inside the same transaction as
  the insert, after locking the user row. Eviction and login are audited together.
- Every protected request re-reads the session, the user status, and the roles
  from PostgreSQL. Revocation is therefore immediate: `logout`/`logout-all`,
  individual revocation, `revoked_at`, suspension, idle expiry, absolute expiry,
  and rotation all make the old token fail on the very next request.
- A handler that clears `bf_session` suppresses pending rotation cookies, so a
  response cannot re-add a live-looking session cookie after logout or
  self-revocation.

### Primary owner

`DISCORD_OWNER_ID` is optional. When it contains a valid Discord snowflake, every
session resolution compares it with the `users.discord_id` stored for the
authenticated account. On a match, the server appends `owner` to the effective
roles for that request.

- The id is read from server environment configuration only. Headers, cookies,
  query parameters, and request bodies are never consulted.
- The `owner` role is derived per request and is **not** written to `user_roles`.
  The database check constraint therefore still allows only `user`, `moderator`,
  and `admin`.
- `owner` satisfies the existing admin route gate and every permission that
  grants `admin`, through `hasAdminAccess` and `ADMIN_ROLES`. Regular users and
  moderators receive no new capability.
- An empty or absent value disables owner identification. A malformed value
  makes environment parsing fail instead of silently granting nothing.
- Changing the value takes effect after the server process restarts. Revoking
  ownership needs no database cleanup and invalidates nothing else; the next
  request simply stops deriving the role.

### CSRF contract

Cookie-authenticated unsafe methods (`POST`/`PUT`/`PATCH`/`DELETE`) require both:

1. an `Origin` header equal to the `APP_URL` origin, and
2. a `x-csrf-token` header equal to the `csrfToken` returned by
   `GET /api/auth/session`.

The expected token is derived server-side from the session token hash, so the
non-`HttpOnly` `bf_csrf` cookie is only a delivery hint and is never trusted on
its own.

### Auth retention (30 days)

Raw IP and user-agent values are kept for at most 30 days. `npm run db:retention`
nulls those columns in `audit_logs` and `sessions` once the row is older than the
window. Audit rows and session rows (including revoked and expired sessions) are
kept; only the sensitive metadata is redacted. The same pass deletes consumed or
expired `oauth_states` rows, including their stored PKCE verifiers.

The command loads `.env.local`/`.env` the same way `db:migrate` does, prints only
counts, and is safe to rerun. Run it manually or from any scheduler, for example:

```bash
npm run db:retention
```

### Discord OAuth setup (manual, local only)

Creating the Discord application is an owner action and is **not** performed by
this repository. When you have credentials:

1. In the Discord Developer Portal, create an application.
2. Add the redirect URI `http://localhost:3000/api/auth/callback`, which must
   match `DISCORD_REDIRECT_URI` and `${APP_URL}/api/auth/callback` exactly.
3. Put `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, and
   a random `SESSION_HMAC_SECRET` (16+ characters) in `.env.local`.

Without those values, login fails closed with `503`; the test suite uses an
in-memory mock provider and makes no external network calls.

**PKCE enforcement status:** the client generates an S256 challenge, stores the
verifier server-side with the state, and sends that verifier on token exchange.
The unit tests prove the pairing and the exchange input. Verifying that Discord
itself rejects a wrong or missing verifier requires a real application and
external calls, which are out of scope here, so that check is **PENDING**.

## Architecture notes

- `src/core/` — environment parsing, errors, responses, request IDs, logging.
- `src/db/` — pool, Kysely, transactions, hashing, idempotency, rate limiter.
- `src/http/` — routing and the single request pipeline.
- `src/middleware/` — body limits, CSRF origin hook, session boundary, validation.
- `src/routes/` — endpoint definitions.
- `test/` — unit tests plus migration tests on `@electric-sql/pglite`.

### Idempotency (D10)

`withIdempotency` claims `(scope, key_hash)` inside the same transaction as the
protected mutation. The request body is stored only as a canonical SHA-256 hash.
Reuse of a key with a different body returns `409 idempotency_conflict`. A key
still in `processing` returns `409`. Completed responses replay the stored safe
body; one-time secrets are returned once and never persisted.

### Rate limiting (D11)

`PostgresRateLimiter` uses a fixed window. Bucket identifiers are HMAC-SHA-256
values, so raw IPs, user IDs, and key IDs are never stored. Multiple dimensions
are checked and incremented in one transaction and roll back together. On store
failure the default policy is `fail_closed`; `fail_open` returns a `degraded`
decision and is opt-in per route. A fail-closed store failure responds `503`, not
`429`, so an outage is not reported as caller misbehavior.

### Request pipeline hooks

Every request runs through one pipeline: request ID, route match, CSRF origin
check when a route sets `csrf: true`, optional rate limiting, session resolution,
handler, centralized error mapping, and an access log. Middleware modules provide:

- `readJsonBody` — Content-Type and byte-size limits before parsing.
- `assertSameOrigin` — allowlisted Origin for unsafe methods.
- `assertCsrfToken` — per-session synchronizer token for authenticated mutations.
- `SessionResolver` — resolves `bf_session` against PostgreSQL on every request;
  the Phase 1 `null` stub is replaced by the OAuth-backed resolver.
- `validate` — Zod parsing with a single 400 issue shape.

## Tests

```bash
npm test
```

The migration test starts an embedded PostgreSQL instance, applies
`0001_init.sql` from zero, and asserts constraints, partial unique indexes, and
RLS. It does not require a running database server.

Phase 2 adds tests for PKCE (challenge/verifier pairing), OAuth state
single-use/expiry/browser binding, configuration validation, provider failure
mapping, the full HTTP login/session/logout flow, CSRF and origin enforcement,
role/permission guards, session expiry (idle and absolute), rotation, immediate
revocation, `logout-all`, and the guarantee that tokens, codes, state, and the
client secret never reach logs or the database. The suite uses an in-memory mock
Discord provider, so it needs no real credentials and no network access.

Phase 2.1 adds coverage for the five-session cap and oldest-session eviction, the
concurrent-login invariant, owner-scoped listing and revocation, uniform `404`
responses for foreign or already-revoked ids, self-revocation cookie clearing,
rotation-cookie suppression after logout, suspended-account rejection, and
retention redaction/OAuth-state cleanup. PGlite serializes transactions behind one
mutex, so the concurrency test proves the cap invariant but does not independently
demonstrate real PostgreSQL row-lock contention.

### Real-PostgreSQL concurrency test (opt-in)

This suite runs only against the dedicated database `boyfinity_concurrency_test`.
It is **not** part of `npm test`; ordinary tests never open an external database.

**Never point this test at `boyfinity_dev`.** The test-only migration runner and
test helper reject any database name other than `boyfinity_concurrency_test`, and
also reject a URL identical to `DATABASE_URL`.

Create the database once, using your local PostgreSQL role:

```powershell
createdb -h localhost -p 5432 -U postgres boyfinity_concurrency_test
```

Or run an isolated official PostgreSQL container on a non-default port:

```powershell
docker run --name boyfinity-concurrency-test -e POSTGRES_PASSWORD=postgres -p 55432:5432 -d postgres:16-alpine
docker exec boyfinity-concurrency-test createdb -U postgres boyfinity_concurrency_test
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:55432/boyfinity_concurrency_test"
```

Stop and remove the container when finished with
`docker rm -f boyfinity-concurrency-test`.

Otherwise, provide the dedicated connection URL in the current shell. Use a
password manager, `.pgpass`, or a CI secret; do not echo it or commit it:

```powershell
$env:TEST_DATABASE_URL = Read-Host "Concurrency test database URL"
```

Apply the reviewed migration to that database only:

```powershell
npm run db:migrate:test
```

Run the integration suite:

```powershell
npm run test:integration:concurrency
```

Remove the variable from the shell afterward:

```powershell
Remove-Item Env:TEST_DATABASE_URL
```

The test uses a dedicated `pg.Pool`, real `BEGIN` / `COMMIT` / `ROLLBACK`
transactions, a fake Discord client, and a unique test identity per run. It
verifies five active sessions, three revoked sessions, eviction order, audit
consistency, and immediate rejection of revoked credentials, then deletes only
the rows it created.

## Continuous integration

`.github/workflows/ci.yml` runs type check, lint, formatting check, tests, and a
production build, plus a separate job that applies the migration twice against a
PostgreSQL 16 service to prove the SQL applies from zero and re-runs safely. The
workflow has not been executed in this environment because no Git remote or CI
runner is configured.
