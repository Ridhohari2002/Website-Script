## BOYFINITY HUB — PHASE 3C ACCEPTANCE REVIEW

### 1. Executive Summary

Phase 3C is functionally complete and passes every verification gate re-executed during this audit: TypeScript, ESLint, Prettier, the full Vitest suite, the production build, and live HTTP checks against a production server started with the approved temporary origin (`https://boyfinity.invalid`).

The implementation correctly establishes a read-only server page-session resolver, a server-enforced authenticated route group, dynamic/no-store dashboard rendering, safe login redirect construction, and a client auth navigation that fails closed. No session token, token hash, secret, or account data was found in static output or client bundles.

Two non-blocking findings remained:

1. **Session lifecycle policy mismatch (Medium).** The authenticated header performs `GET /api/auth/session` after page load. That endpoint calls the existing `resolveSession()`, which can touch the idle window or rotate the token. Therefore page loads can extend an idle session, directly contradicting the dashboard copy that said page navigation does not extend the idle window.
2. **Nested `<main>` landmark in the authenticated error boundary (Low).** The authenticated layout rendered `<main id="main">` and `error.tsx` rendered another `<main>` inside it.

Neither finding permitted authentication bypass, privilege escalation, cross-user data exposure, or open redirect. The first was a policy and copy accuracy issue with a real but bounded session-lifetime effect; the second was an accessibility and HTML-validity issue.

No browser automation was available or performed. Browser-dependent behavior remained unverified.

---

### 2. Acceptance Decision

**ACCEPTED WITH NON-BLOCKING FINDINGS**

Core acceptance requirements were met. The findings were assigned to a follow-up remediation phase (Phase 3C.1).

---

### 3. Audit Results

#### Audit A — Session Resolver

**PASS WITH FINDINGS**

- Genuinely read-only: `lookupPageSession()` only hashes the presented token and performs a single `findSessionByTokenHash()` read. It never calls `resolveSession()`, `touchSession()`, `rotateSessionToken()`, `insertSession()`, or any delete. Evidence: `src/modules/auth/page-session.ts:48-76`.
- Lookup uses only `hashSessionToken()` and `findSessionByTokenHash()`: `src/modules/auth/page-session.ts:53-54`.
- Session state checks match the API path: revoked (`:56`), non-active user status (`:57`), idle expiry (`:58`), absolute expiry (`:59-61`). Covered by tests at `test/page-session.test.ts:120-187`.
- Missing `bf_session` returns `null` before hashing or database access: `src/modules/auth/page-session.ts:51`; server wrapper early-returns even earlier at `src/modules/auth/page-session.server.ts:18-19`.
- `bf_csrf` is read by `readPageSession()` regardless of session presence (`page-session.ts:83-87`), but it has no authentication effect, and the production wrapper never reaches that call without a session token (`page-session.server.ts:18-21`). Not a security defect; informational only.
- Roles come exclusively from the database join through `user_roles` (`src/modules/auth/session-store.ts:60-70`), never from client input.
- Return type contains no raw token, hash, OAuth token, or credential. The `csrfToken` field is a derived synchronizer value by design, not the session credential. Tested at `test/page-session.test.ts:103-118`.
- `next/headers` is isolated to `src/modules/auth/page-session.server.ts:1,17`.
- React `cache()` is request-scoped memoization, suitable for deduplicating layout and page lookups within one render. No module-level mutable state holds session data. Cross-request isolation is structurally sound but not directly test-covered (see Audit F).
- Errors fail closed: a thrown lookup error propagates as a server error rather than producing a session. A malformed or missing row returns `null`.
- One deliberate difference from the API resolver: the page resolver does not touch, rotate, or attach `setCookies`. This is the intended read-only design (`page-session.ts:6-12`).

#### Audit B — Authenticated Route Protection

**PASS WITH FINDINGS**

- The layout is a real server-side gate: `app/(authenticated)/layout.tsx:19-22` calls `getPageSession()` and redirects on `login`.
- The dashboard re-checks the session before rendering: `app/(authenticated)/dashboard/page.tsx:37-39`.
- Redirect target is `loginPathFor("/dashboard")`, which reduces to a same-origin path: `src/modules/auth/page-access.ts:9-10`.
- No user-specific data can enter static HTML. The build produced no `dashboard.html`, and `/dashboard` is classified dynamic (`ƒ`) in build output. Runtime response is `307` to login with `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
- `dynamic = "force-dynamic"` and `revalidate = 0` are present: `app/(authenticated)/layout.tsx:16-17`.
- Loading state exposes only generic skeleton text: `app/(authenticated)/loading.tsx:1-13`.
- Error state renders generic copy and does not print the error to the page: `app/(authenticated)/error.tsx:20-30`.
- Page failures fail closed. A layout-level failure surfaces as a server error, not authenticated content. Note: `app/(authenticated)/error.tsx` covers the page segment, not a throw inside its own layout.
- No role or permission checks were invented. The dashboard performs no admin gating.
- Finding: nested `<main>` landmarks. Layout `app/(authenticated)/layout.tsx:33` and boundary `app/(authenticated)/error.tsx:21` both rendered `<main>`.

#### Audit C — Authentication Navigation

**PASS WITH FINDINGS**

- One `useAuthNav()` per header mount: `src/components/site/site-header.tsx:22`. Desktop and mobile views consume the same state (`:50-56`, `:115-126`).
- One initial request per mount via a `[]` effect with abort cleanup: `src/components/site/auth-nav.tsx:23-35`. Under React StrictMode in development the effect is intentionally double-invoked, so "exactly one" is strict only in production; the first request is aborted. No polling and no retry loop exist.
- Request uses `credentials: "same-origin"` and `cache: "no-store"`: `src/lib/auth-client.ts:50-56`.
- All four states are handled: loading (`auth-nav.tsx:114-123`), anonymous (`:125-135`), unavailable (`:137-147`), authenticated (`:149-190`).
- Client roles are ignored. `authStateFromPayload()` extracts only `id`, `username`, and `avatarUrl`: `src/lib/auth-client.ts:24-42`; tested at `test/auth-ui.test.ts:74-85`.
- No session token or CSRF secret is rendered. The session cookie is HttpOnly; the CSRF cookie is deliberately JS-readable but never displayed.
- Display names are control-character-stripped and truncated: `src/lib/auth-client.ts:108-114`.
- Avatar URLs were not scheme-validated in the client (`src/lib/auth-client.ts:19-20,38-39`; rendered at `auth-nav.tsx:75-89`). The URL originated from the trusted same-origin session endpoint and server-side Discord data, so practical risk was low; see Finding F3.
- The documented tradeoff was **not fully accurate**. The header's session request reaches `resolveSession()` through the API pipeline (`src/http/app.ts:82`), which can touch or rotate (`src/modules/auth/service.ts:409-431`) and return `setCookies` (`:445`), applied at `src/http/app.ts:130`. Loading the public site in a browser therefore can extend the idle window and issue new cookies. This contradicted `app/(authenticated)/dashboard/page.tsx:146-149`.

#### Audit D — Login, Logout, and CSRF

**PASS**

- Login uses the existing `GET /api/auth/login` handler: `src/routes/auth.ts:25-47`. No OAuth logic is duplicated in the UI.
- OAuth state validation and PKCE are preserved in the service: `src/modules/auth/service.ts:254-273` (state and verifier creation), `:284-296` (cookie/state comparison, single-use consumption, verifier use).
- `next` is sanitized by `safeRedirectPath()` before storage: `src/modules/auth/service.ts:260`; the page layer also sanitizes before constructing the login URL (`src/modules/auth/page-access.ts:9-10`).
- External, protocol-relative, backslash, control-character, and overlong targets are rejected: `src/modules/auth/redirect.ts:6-11`; tested at `test/page-access.test.ts:43-60`.
- Logout posts to the existing endpoint with `POST`, `credentials: "same-origin"`, and `x-csrf-token` read from `document.cookie` at click time: `src/lib/auth-client.ts:82-97`.
- Missing CSRF cookie, 403, other non-OK responses, and network failures are distinguished and never reported as success unless the request succeeded: `src/lib/auth-client.ts:85-104`; tested at `test/auth-ui.test.ts:128-187`.
- Navigation and state reset happened only after `ok: true`: `src/components/site/auth-nav.tsx:42-48`.
- CSRF enforcement is server-side: origin allowlist plus synchronizer token for unsafe authenticated requests (`src/http/app.ts:111-118`, `src/middleware/csrf.ts:17-23`). No bypass was found. Browser-supplied `Origin` is required, not trusted as an authorization claim.
- Minor: an already-expired session logout returned `401`, which was displayed as a generic failure rather than "already signed out." UX only, not a security issue (Finding F4).

#### Audit E — Dashboard Data Integrity

**PASS**

- Welcome name derives from the server session (`app/(authenticated)/dashboard/page.tsx:37-41`), sanitized by `accountLabel()`.
- Sign-in method is accurate: Discord OAuth is the only implemented login path (`src/routes/auth.ts:25-69`).
- Account status reflects the verified `users.status` check performed during lookup (`page-session.ts:57`); a suspended account cannot render the dashboard.
- Idle expiry comes from the actual session row `expires_at` (`page-session.ts:74`) and is formatted predictably (`dashboard/page.tsx:24-28`). Note: the header's follow-up session request can extend the server value after render, so the displayed timestamp may be stale by one touch interval.
- No fabricated key counts, subscriptions, payments, HWID data, or statistics exist. The empty states explicitly state the functionality is not built (`dashboard/page.tsx:126-144`).
- "Available now" claims are limited to Discord sign-in, server-verified session rendering, and sign-out (`dashboard/page.tsx:30-34`).
- Copy was honest except the idle-window sentence at `dashboard/page.tsx:146-149`, which was contradicted by the header's session request (Finding F1).

#### Audit F — Test Quality

**PASS WITH FINDINGS**

- All four Phase 3C test files were inspected in full. They contained 29 tests: `page-session.test.ts` 10, `auth-ui.test.ts` 14, `page-access.test.ts` 4, `page-session-server.test.ts` 1.
- Full suite result: **220 passed / 23 files**, exactly consistent with 191 baseline + 29 added. The baseline count itself was not independently reproduced because no baseline snapshot or VCS history exists.
- Security-relevant outcomes are tested: null results for expired, absolute-expired, revoked, suspended, and deleted-user sessions; non-mutation of session rows; token and hash non-exposure; role source; redirect sanitization; CSRF failure modes; malformed payload failure; role ignoring.
- Tests use realistic database-backed harnesses for the resolver rather than only mocking internals (`test/page-session.test.ts`).
- Gaps:
  - `test/page-session-server.test.ts` covers only the missing-cookie early return. The cookie-present path and React `cache()` deduplication are not integration-tested.
  - Cross-user cache isolation is not directly tested; it relies on React's documented request-scoped `cache()` semantics.
  - The `useAuthNav` effect itself (single fetch per mount, abort cleanup, StrictMode behavior) is not tested; only `loadAuthState` and `AuthNavView` are tested separately.
  - No test asserted the observable session touch or rotation caused by `/api/auth/session`, which is why the documented tradeoff went unchallenged.
  - Avatar URL scheme validation was untested and unimplemented.
- Existing authentication suites (`auth-guards`, `auth-http`, `auth-oauth`, `auth-pkce`, `auth-sessions`, `auth-state`, `auth-config`, `auth-retention`) all pass, showing no regression in prior auth behavior.

#### Audit G — Static Generation and Cache Isolation

**PASS**

Build classification (Turbopack, Next.js 16.4.6):

| Route | Classification |
|---|---|
| `/` | Static (`○`) |
| `/catalog` | Static (`○`) |
| `/pricing` | Static (`○`) |
| `/docs` | Static (`○`) |
| `/dashboard` | Dynamic (`ƒ`) |
| `/api/[...path]` | Dynamic (`ƒ`) |

Runtime checks against `next start -p 3100` with no cookies:

| Route | Status | Cache-Control | Notes |
|---|---|---|---|
| `/` | 200 | `s-maxage=31536000` | Public HTML |
| `/catalog` | 200 | `s-maxage=31536000` | Public HTML |
| `/pricing` | 200 | `s-maxage=31536000` | Public HTML |
| `/docs` | 200 | `s-maxage=31536000` | Public HTML |
| `/dashboard` | 307 | `private, no-cache, no-store, max-age=0, must-revalidate` | `location: /api/auth/login?next=%2Fdashboard` |
| `/does-not-exist` | 404 | no-store | Correct |
| `/api/auth/session` | 401 | `no-store` | No cookie, no DB access |

- No `dashboard.html` exists in `.next/server/app`; authenticated content is not prerendered.
- Static HTML for `/`, `/catalog`, `/pricing`, and `/docs` contains no `bf_session`, `bf_csrf`, `csrfToken`, or test user data.
- `.next/static` contains no `hashSessionToken`, `SESSION_SECRET`, `sessionSecret`, `token_hash`, or `getSessionSecret` references.
- Security headers are applied to public HTML (CSP report-only, frame denial, nosniff, HSTS in production).
- Build did read `.env.local` (Next reported it) but did not modify it. Only generated `.next` output was written.

#### Audit H — Security Regression

**PASS WITH FINDINGS**

No Git repository exists, so no true diff or protected-file comparison against the pre-implementation state is possible. Review was source-based plus hash and timestamp capture.

- No session fixation: login creates a fresh opaque token; rotation replaces the hash in place (`src/modules/auth/session-store.ts:93-117`).
- No session leakage: HttpOnly session cookie; page session return type excludes token and hash; client bundles and static HTML are clean.
- No cross-user caching: dashboard is dynamic and no-store; `getPageSession()` is request-scoped.
- No open redirect: `safeRedirectPath()` is applied at both UI and service layers.
- CSRF: header echo plus origin allowlist on unsafe authenticated requests; no bypass found.
- XSS: display names and error copy are React-escaped; no raw HTML injection. Avatar URL scheme hardening was absent but the source was trusted (F3).
- No privilege escalation or role spoofing: the page layer never authorizes; the dashboard has no role checks to bypass; API roles remain database-derived.
- No authentication bypass: unauthenticated `/dashboard` redirects; expired, revoked, and suspended sessions return `null`.
- Sensitive errors are not rendered; only generic messages reach the UI.
- Cookie assumptions are consistent with the existing implementation.
- External navigation is limited to same-origin paths.
- Protected architecture is intact: no Server Actions, no rewrites, single API entry point (`next.config.ts:55-65`), and no modifications to the protected files during this audit.

#### Audit I — Real Browser Testing Readiness

**FAIL / NOT AVAILABLE**

- No Playwright, Puppeteer, Cypress, Selenium, WebDriver, jsdom, Testing Library, or happy-dom dependency is present in `package.json` or `node_modules`.
- No browser binaries or test runner were installed.
- No browser testing occurred. See Section 6 for the exact unverified surface.

---

### 4. Security Findings

#### F1 — Page loads can touch or rotate sessions, contradicting the documented idle-window policy

- **Severity:** Medium
- **Affected files/lines:**
  - `src/components/site/auth-nav.tsx:23-35` (mount effect)
  - `src/lib/auth-client.ts:45-65` (`GET /api/auth/session`)
  - `src/http/app.ts:82` (`resolveSession(request)`)
  - `src/modules/auth/service.ts:409-431` (rotation and touch), `:445` (`setCookies`)
  - `src/http/app.ts:130` (rotation cookies applied)
  - `app/(authenticated)/dashboard/page.tsx:146-149` (contradictory copy)
- **Evidence:** Every header mount issues a session request. That request passes through the authenticated API pipeline, which calls `resolveSession()`. After 60 seconds since `last_seen_at`, `touchSession()` extends `expires_at`; after 24 hours since creation or rotation, the token is rotated and new cookies are returned.
- **Impact:** A user who keeps loading pages or hard-refreshing keeps extending the idle window and can remain signed in until the 7-day absolute cap. The dashboard explicitly stated page navigation does not extend the idle window, so the security policy was misdescribed. Rotation on page load also means the displayed "Session idle expiry" can be stale. No direct account takeover was enabled.
- **Recommended remediation:** Decide the intended policy. Either make the navigation session check a strictly read-only endpoint that never touches or rotates, or accept navigation as activity and correct the dashboard and resolver comments. The owner selected the second option.
- **Status:** Deferred to Phase 3C.1.

#### F2 — Nested `<main>` landmarks in the authenticated error path

- **Severity:** Low
- **Affected files/lines:** `app/(authenticated)/layout.tsx:33`, `app/(authenticated)/error.tsx:21`
- **Evidence:** The layout wraps children in `<main id="main">`; when the page throws, the segment error boundary renders another `<main>` inside that element.
- **Impact:** Invalid landmark structure and duplicate `main` roles for assistive technology. It does not affect authentication or data exposure.
- **Recommended remediation:** Render the error boundary as a `<div>` or `<section>`, or restructure the layout so only one `main` exists.
- **Status:** Deferred to Phase 3C.1.

#### F3 — Avatar URL is accepted without scheme validation

- **Severity:** Informational / Low
- **Affected files/lines:** `src/lib/auth-client.ts:19-20,38-39`; `src/components/site/auth-nav.tsx:75-89`
- **Evidence:** `safeString()` accepted any non-empty string and the value was used directly as `<img src>`. The URL was supplied by the trusted same-origin session endpoint, which in turn uses server-side Discord data.
- **Impact:** A compromised or misconfigured account record could cause requests to an unexpected HTTPS host (allowed by CSP `img-src https:`) or a `data:` image. No script execution is possible through `<img>`, and `referrerPolicy="no-referrer"` is set.
- **Recommended remediation:** Validate that the avatar URL is an absolute `https:` URL on the expected Discord CDN host before rendering.
- **Status:** Deferred to Phase 3C.1.

#### F4 — Logout failure mapping is coarse for already-expired sessions

- **Severity:** Informational
- **Affected files/lines:** `src/lib/auth-client.ts:99-104`; `src/components/site/auth-nav.tsx:52-58`
- **Evidence:** `401` fell into `rejected` and the UI said "Sign out failed. Try again." A missing CSRF cookie said "Session check failed." Both were safe, but imprecise.
- **Impact:** UX confusion only; no security impact.
- **Recommended remediation:** Treat `401` as an already-signed-out state and separate the missing-CSRF message.
- **Status:** Deferred to Phase 3C.1.

#### F5 — Protected-file non-modification cannot be proven cryptographically without VCS

- **Severity:** Informational
- **Affected files:** `supabase/migrations/0001_init.sql`, `IMPLEMENTATION_PLAN.md`, `DESIGN.md`, `AGENTS.md`, `.env.local`
- **Evidence:** No `.git` directory exists. Hashes and timestamps were captured but there is no pre-Phase-3C baseline to compare against.
- **Impact:** Audit assurance limitation, not an implementation defect.
- **Recommended remediation:** Initialize version control before the next phase, or store protected-file hashes in the implementation record.
- **Status:** Documented only.

---

### 5. Test Verification

All commands below were executed during this audit.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** |
| Lint | `npm run lint` | **PASS** |
| Format | `npm run format:check` | **PASS** |
| Tests | `npm test` | **PASS**, 23 files, 220 tests, 0 failed |
| Build | `NEXT_PUBLIC_SITE_URL=https://boyfinity.invalid npm run build` | **PASS**, 17/17 static pages generated |
| Runtime | `next start -p 3100` plus HTTP requests | **PASS** |

Test-file breakdown (29 Phase 3C tests):

| File | Tests |
|---|---|
| `test/page-session.test.ts` | 10 |
| `test/auth-ui.test.ts` | 14 |
| `test/page-access.test.ts` | 4 |
| `test/page-session-server.test.ts` | 1 |
| **Total** | **29** |

This matched the reported 191 + 29 = 220 and 23 files. The 191 baseline was not independently re-run because no baseline checkout exists.

Runtime results (production server, unauthenticated):

- `/`, `/catalog`, `/pricing`, `/docs` returned `200` with static cache headers.
- `/dashboard` returned `307` to `/api/auth/login?next=%2Fdashboard` with no-store.
- Unknown route returned `404` with no-store.
- `/api/auth/session` returned `401` with `cache-control: no-store` and no database access without a cookie.

No test failed and no command required network access to PostgreSQL. The build used only the approved `.invalid` origin override.

Distinction from the implementation report: every result in this section was newly executed here. The reported baseline count and prior run results were not accepted as evidence.

---

### 6. Browser Verification

**No browser testing was performed.**

Confirmed unavailable:

- No Playwright, Puppeteer, Cypress, Selenium, or WebDriver dependency.
- No jsdom, happy-dom, or Testing Library dependency.
- No browser binaries were installed, and installation was prohibited.

Remaining browser-dependent behaviors not verified:

- Hydration of the auth navigation and the actual `GET /api/auth/session` request in a real browser.
- Cookie storage and rotation behavior after a real login and after session rotation.
- Desktop and mobile menu interaction, dialog focus management, and focus restoration.
- `router.push("/")` and `router.refresh()` after logout.
- Actual `Origin` header emission on same-origin logout POST.
- Visual layout, responsive behavior, contrast, and keyboard navigation.
- Avatar rendering and broken-image behavior.
- Loading-to-authenticated transition and unavailable-state fallback.
- Session touch and rotation observed end-to-end through the browser.

The source-level, SSR, HTTP, and unit evidence supported the implementation, but it was not a substitute for browser verification.

---

### 7. Protected Files Compliance

Hashes and timestamps were captured at the start and re-checked after verification commands. No protected file changed during this audit.

| File | SHA-256 | Last write | Status |
|---|---|---|---|
| `supabase/migrations/0001_init.sql` | `5926F96E…E0C3` | 2026-11-11 12:45:05 | Unchanged during audit |
| `IMPLEMENTATION_PLAN.md` | `75E20576…5DFFC` | 2026-11-11 13:00:47 | Unchanged during audit |
| `DESIGN.md` | `0194631D…05BF3` | 2026-11-10 13:22:30 | Unchanged during audit |
| `AGENTS.md` | `D7D4C9B7…E515` | 2026-11-10 13:22:35 | Unchanged during audit |
| `.env.local` | `1D4B04D2…E001` | 2026-11-11 16:34:53 | Unchanged during audit |
| `.env` | — | — | Absent, as before |

Limitation: no Git repository exists, so these hashes prove stability during this audit only, not equality with the pre-Phase-3C state. No source, test, config, package, or environment file was modified. The only writes were generated `.next` build output from the authorized verification build.

---

### 8. Remaining Risks

1. **Idle-timeout policy was not what the dashboard said.** Page loads generate session API traffic that can touch or rotate. Addressed in Phase 3C.1.
2. **Displayed idle expiry could be stale.** The header request can extend the expiry immediately after the server-rendered value is produced. Addressed in Phase 3C.1.
3. **No browser verification.** Hydration, cookie rotation, logout flow, focus behavior, and mobile navigation remain untested in a real browser.
4. **No cross-user cache test.** Request scoping is correct by framework contract, but not empirically exercised with two users.
5. **No VCS baseline.** Protected-file integrity before Phase 3C cannot be independently proven.
6. **Avatar URL trust boundary.** The client trusted the session endpoint's avatar string without host or scheme validation. Addressed in Phase 3C.1.
7. **Layout-level errors bypass the friendly boundary.** The authenticated `error.tsx` boundary catches page errors, not a throw inside its own layout; users see the framework error page in that case. It still fails closed.
8. **`readPageSession()` reads `bf_csrf` without a session check.** No authentication effect; the production wrapper prevents the read. Informational.
9. **StrictMode double-fetch in development.** The navigation effect is single-run in production but intentionally double-invoked in development, so development network traces may show two aborted or duplicate session requests.

---

### 9. Acceptance Checklist

| Requirement | Status |
|---|---|
| Read-only page-session resolver | **PASS** |
| No session writes on page rendering | **PASS** |
| Missing session cookie returns null without DB access | **PASS** |
| Revoked, inactive, idle-expired, absolute-expired, missing-user handling | **PASS** |
| Roles sourced from database only | **PASS** |
| No token, hash, or credential exposure | **PASS** |
| Server-side authenticated layout gate | **PASS** |
| Dashboard re-validates session | **PASS** |
| `/dashboard` dynamic and no-store | **PASS** |
| Public pages remain static | **PASS** |
| No user data in static HTML or client bundles | **PASS** |
| Safe login return paths and no open redirect | **PASS** |
| Existing OAuth state and PKCE preserved | **PASS** |
| Logout uses existing POST endpoint with CSRF header | **PASS** |
| Logout failure cases do not claim success | **PASS** |
| Honest dashboard empty states | **PASS** |
| Loading and error states hide internals | **PASS**, with nested `<main>` finding |
| Phase 3C test coverage | **PASS WITH GAPS** |
| 220 tests across 23 files | **PASS** |
| Typecheck, lint, Prettier, build | **PASS** |
| Runtime route and cache behavior | **PASS** |
| Protected files unchanged | **PASS for this audit; pre-phase baseline unverified** |
| Browser testing | **NOT VERIFIED / NOT AVAILABLE** |
| Idle-window documentation accuracy | **FAIL** (Finding F1) |
| No nested main landmarks | **FAIL** (Finding F2) |

---

### 10. Owner Approval Recommendation

Phase 3C was ready for owner acceptance as **ACCEPTED WITH NON-BLOCKING FINDINGS**.

The security boundary was sound: unauthenticated users could not reach dashboard content, session data never entered static output, redirects were constrained to same-origin paths, logout was CSRF-protected, and all automated gates passed. The findings were policy, accessibility, and accuracy issues rather than an authentication bypass.

The owner subsequently authorized Phase 3C.1 to resolve F2, F3, and F4 in code and F1 as an Option B documentation correction.

No Phase 4 work has been started or authorized.
