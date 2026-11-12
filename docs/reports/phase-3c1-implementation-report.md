# BOYFINITY HUB — PHASE 3C.1 IMPLEMENTATION REPORT

## 1. Executive Summary

Phase 3C.1 resolved the four owner-approved findings without changing the authentication architecture.

F1 was resolved as documentation and policy accuracy only. The session pipeline, resolver, touch behavior, rotation semantics, cookie configuration, timeouts, and session cap are untouched. The dashboard, resolver comment, and session documentation now state that an authenticated session check counts as activity and can extend the idle window, while the absolute expiry remains enforced.

F2 removed the nested `<main>` landmark from the authenticated error path by rendering a labelled `<section>` instead. The layout remains the sole `<main id="main">`, so the skip link is unchanged.

F3 added strict avatar URL validation using URL parsing. The client now accepts only HTTPS URLs on `cdn.discordapp.com`, with no explicit port and no embedded credentials. Invalid, missing, or unsafe values fall back to the initials avatar.

F4 separated logout outcomes. A `401` now resets the local UI and navigates home without claiming that this request revoked the session. `403`, other HTTP failures, a missing CSRF cookie, and network failures each produce distinct, accurate messages and do not navigate.

Final verification passed: typecheck, lint, Prettier, 230 tests across 24 files, production build, and runtime route checks. No browser automation is available, so browser interaction remains unverified.

---

## 2. Owner Decisions

- **F1 Option B preserved:** `GET /api/auth/session` continues to use `resolveSession()`. Touch, rotation, idle timeout, absolute lifetime, rotation interval, and the five-session cap are unchanged. No endpoint was added or modified.
- **F2 fixed:** the authenticated error fallback no longer renders a nested `<main>`.
- **F3 fixed:** avatar URLs are validated against an explicit HTTPS Discord CDN policy.
- **F4 fixed:** `401` is distinguished from confirmed revocation and from other failures.

---

## 3. Files Created, Modified, Deleted

### Created

| File | Purpose |
|---|---|
| `test/authenticated-landmarks.test.ts` | Regression tests for one main landmark in the authenticated layout, no main landmark in the error fallback, and accessible error labelling. |

### Modified

| File | Purpose |
|---|---|
| `src/lib/auth-client.ts` | Added `safeAvatarUrl()`, applied it to session payload parsing, expanded logout result mapping, and added `logoutOutcome()`. |
| `src/components/site/auth-nav.tsx` | Uses `logoutOutcome()` to decide navigation versus error display. |
| `app/(authenticated)/error.tsx` | Replaced the nested `<main>` with a labelled `<section>`. |
| `app/(authenticated)/dashboard/page.tsx` | Corrected idle-session copy and clarified the displayed expiry. |
| `src/modules/auth/page-session.ts` | Clarified the distinction between read-only page rendering and the header's session check. |
| `docs/setup.md` | Documented that navigation-triggered session checks count as activity. |
| `test/auth-ui.test.ts` | Added avatar policy tests, the `401` logout case, and logout outcome tests; updated existing fixtures for the new contracts. |

### Deleted

None.

No dependencies, package files, migrations, environment files, or API routes were modified.

---

## 4. Detailed Remediation

### F1: Session idle-touch policy, Option B

**Decision preserved:** page rendering remains read-only, and the existing API pipeline remains authoritative.

**Documentation corrected:**

- `app/(authenticated)/dashboard/page.tsx:146-151` now states: an authenticated session check counts as activity, loading the site while signed in can extend the idle window, checks are throttled, the absolute expiration is always enforced, and the displayed expiry reflects the page-render value and may update after the next check.
- `src/modules/auth/page-session.ts:6-14` now explains that page rendering itself does not touch or rotate, while the header's separate `/api/auth/session` request follows the normal pipeline and counts as activity.
- `docs/setup.md:154-158` now records that navigation-triggered session checks use the normal resolver and can extend the idle window.

**Unmodified by design:**

- `src/modules/auth/service.ts` `resolveSession()`
- `src/modules/auth/session-store.ts` `touchSession()` and `rotateSessionToken()`
- `src/modules/auth/config.ts` lifetimes and rotation interval
- Session cookie configuration and the five-session cap
- `src/routes/auth.ts` and the existing endpoint contracts

### F2: Nested main landmark

- `app/(authenticated)/layout.tsx:33` still renders the single `<main id="main">`.
- `app/(authenticated)/error.tsx:20-43` now renders `<section aria-labelledby="authenticated-error-title">`.
- The error heading carries `id="authenticated-error-title"`.
- The reset button and home link are unchanged, preserving recovery behavior.
- The skip-link destination remains `#main` in the layout.

### F3: Avatar URL validation

Implemented in `src/lib/auth-client.ts:24-51`:

- Parses input with `new URL()`, not string-prefix matching.
- Requires `https:`.
- Requires hostname exactly `cdn.discordapp.com`, the only host built by `src/modules/auth/users.ts:28-33`.
- Rejects explicit ports and embedded username/password.
- Rejects missing, non-string, empty, oversized, relative, protocol-relative, malformed, `javascript:`, `data:`, and `blob:` values.
- Returns `null` silently and never logs the rejected value.

`authStateFromPayload()` now applies the validator at `src/lib/auth-client.ts:65-71`. Invalid avatars therefore fall back to the existing initials avatar in `src/components/site/auth-nav.tsx:81-106`.

### F4: Logout error mapping

Implemented in `src/lib/auth-client.ts:17-22` and `:112-165`:

- `2xx`: `{ ok: true, revoked: true }`.
- `401`: `{ ok: true, revoked: false }`, representing an already unauthenticated request, not confirmed revocation.
- `403`: `{ ok: false, reason: "csrf" }`.
- Missing CSRF cookie: `{ ok: false, reason: "missing-csrf" }`, without calling the endpoint.
- Other HTTP errors: `{ ok: false, reason: "rejected" }`.
- Network failure: `{ ok: false, reason: "network" }`.

`logoutOutcome()` maps results to navigation or a specific message. `src/components/site/auth-nav.tsx:48-60` resets local auth state and navigates home only when `navigate` is true. No success message is shown, and `401` never claims server-side revocation.

The server logout contract was not changed.

---

## 5. Regression Tests

### Added tests

| Test | Behavior covered |
|---|---|
| `accepts the Discord CDN HTTPS avatar host` | Valid existing avatar rendering. |
| `rejects unsafe schemes, hosts, credentials, and malformed values` | HTTP, `javascript:`, `data:`, `blob:`, relative, protocol-relative, unexpected host, subdomain suffix trick, credentials, explicit port, malformed, empty, null, undefined. |
| `drops an invalid avatar from the session payload` | Payload parsing fails closed to `null`. |
| `renders a valid Discord avatar` | Valid URL reaches the image with `referrerPolicy="no-referrer"`. |
| `falls back to initials when the avatar is unsafe` | No unsafe URL in markup, no `<img>`, initials remain. |
| `treats 401 as already unauthenticated, not as confirmed revocation` | `{ ok: true, revoked: false }`. |
| `maps outcomes to navigation and distinct failure messages` | Success, `401`, missing CSRF, `403`, generic failure, and network messages. |
| `renders one main landmark and keeps the skip-link target` | Layout markup has exactly one `<main>`, `id="main"`, and `href="#main"`. |
| `renders the error fallback without a nested main landmark` | Error markup contains zero `<main>` elements. |
| `keeps the error fallback labelled and actionable` | Section label, heading id, error copy, retry button, and home link. |

### Modified tests

| Test | Change |
|---|---|
| `loads a session with a no-store request` | Fixture updated to a valid Discord CDN avatar. |
| `posts to the existing endpoint with the current CSRF cookie` | Expects `{ ok: true, revoked: true }`. |
| `does not call the endpoint when the CSRF cookie is missing` | Expects `reason: "missing-csrf"`. |

### Counts

- Previous total: 220 tests across 23 files.
- Final total: **230 tests across 24 files**.
- Added: **10 tests**.
- Modified: **3 existing tests**.
- Removed: **0 tests**.

---

## 6. Verification Results

All commands were executed after the final edits.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** |
| Lint | `npm run lint` | **PASS** |
| Prettier | `npm run format:check` | **PASS**, all files formatted |
| Tests | `npm test` | **PASS**, 24 files, 230 tests, 0 failed |
| Build | `NEXT_PUBLIC_SITE_URL=https://boyfinity.invalid npm run build` | **PASS**, 17/17 static pages generated |
| Runtime | `next start -p 3100` plus HTTP requests | **PASS** |

Runtime results on the final build:

| Route | Result |
|---|---|
| `/` | `200`, `s-maxage=31536000` |
| `/catalog` | `200`, `s-maxage=31536000` |
| `/pricing` | `200`, `s-maxage=31536000` |
| `/docs` | `200`, `s-maxage=31536000` |
| `/dashboard` | `307` to `/api/auth/login?next=%2Fdashboard`, no-store |
| Unknown route | `404`, no-store |
| `/api/auth/session` without cookie | `401`, no-store |

Build classification remained unchanged: `/` and public content are static or SSG, `/dashboard` and `/api/[...path]` are dynamic. No `dashboard.html` was generated.

A concurrent typecheck executed during the build reported a transient `.next/types` module error while generated types were being rewritten. The isolated final typecheck passed. This was a tooling race, not a source error.

No database migration, real PostgreSQL connection, dependency installation, or environment file change occurred. The build read `.env.local` but did not modify it.

---

## 7. Security Review

- **Avatar trust boundary:** now constrained by URL parsing to HTTPS on `cdn.discordapp.com`, with no port and no credentials. The path is not restricted to `/avatars/`, so a compromised database value could point to another path on the same Discord host. Host-level confinement is the material control; this is a low residual risk.
- **Logout status handling:** `401` resets local state without claiming revocation. `403` reports a security verification failure. Other failures remain on the page with an error. Only confirmed `2xx` reports `revoked: true`.
- **CSRF enforcement:** unchanged. The endpoint still requires the existing server-side origin and synchronizer-token checks. `submitLogout` still reads the CSRF cookie at call time.
- **Session rotation and idle touch:** unchanged. No session service, store, config, cookie, or route file was edited.
- **Main landmark structure:** the authenticated layout owns the only `<main>`. The error fallback is a labelled `<section>`.
- **Session isolation:** unchanged. The page-session resolver remains read-only and request-scoped.
- **Open redirect protection:** unchanged. `safeRedirectPath()` was not modified.
- **Secret exposure:** static chunks contain no `hashSessionToken`, `SESSION_SECRET`, or `token_hash`. Public static HTML contains no session or CSRF data. The only new static-bundle string is the intended `cdn.discordapp.com` host constant.
- **API contracts:** unchanged. `src/routes/auth.ts` was not edited.
- **F1 scope confirmation:** changed files are documentation and comments only for F1. No session behavior was altered.

Residual risks:

1. No browser verification of avatar fallback, logout UI, or landmark behavior.
2. The `useAuthNav` hook's actual `setState` and `router.push` execution is source-verified and outcome-tested, but not DOM-executed because the test environment is Node-only.
3. No VCS baseline for protected files, though hashes match the prior audit.
4. The avatar allowlist does not constrain the path component.

---

## 8. Protected File Compliance

All protected files were read-only and remained untouched.

| File | SHA-256 | Status |
|---|---|---|
| `supabase/migrations/0001_init.sql` | `5926F96E…E0C3` | Unchanged |
| `IMPLEMENTATION_PLAN.md` | `75E20576…5DFFC` | Unchanged |
| `DESIGN.md` | `0194631D…05BF3` | Unchanged |
| `AGENTS.md` | `D7D4C9B7…E515` | Unchanged |
| `.env.local` | `1D4B04D2…E001` | Unchanged |
| `.env` | Absent | Absent |

`package.json` and `package-lock.json` were not modified. No migration was executed.

---

## 9. Browser Verification

No browser testing was performed.

No Playwright, Puppeteer, Cypress, Selenium, WebDriver, jsdom, Testing Library, or happy-dom dependency is present, and no browser tooling was installed.

Remaining unverified browser behaviors:

- Avatar fallback in an actual rendered header.
- Logout `401` and `403` behavior through the real UI.
- Navigation and local state reset after `401`.
- Landmark structure as exposed by the browser accessibility tree.
- Desktop and mobile navigation layouts.
- Hydration of the auth navigation and session request.

Source-level rendering tests, unit tests, the production build, and HTTP checks passed, but they do not constitute browser verification.

---

## 10. Phase 3C.1 Acceptance Status

**COMPLETED — ALL APPROVED FINDINGS RESOLVED.**

All four approved findings were addressed within scope. Existing authentication behavior and protected architecture remain intact.

---

## 11. Phase 4 Authorization

Phase 4 was NOT started and remains unauthorized. Awaiting separate explicit owner approval.

---

## Appendix: AntiSlop Delivery Gate

| Rule | Status | Evidence |
|---|---|---|
| R-02 copy | PASS | No em dash introduced in project UI or documentation copy. |
| R-03 mobile | PASS | No layout or responsive classes changed. |
| R-17 numbers | PASS | No statistics or fabricated numbers added. |
| R-25 contrast | PASS | Existing design tokens were reused; no new colors. |
| R-26 functionality | PASS | Logout outcomes are mapped to real behavior; no dead controls added. |
| R-27 states | PASS | Loading, anonymous, authenticated, unavailable, and error states preserved. |
| R-32 keyboard | PASS | Existing native button and link behavior preserved; no focus styles removed. |
| R-33 patch scripts | PASS | All changes are direct source edits. |
| R-35 verify | PASS with limitation | Build, typecheck, lint, format, tests, and HTTP checks passed. No browser was available for click-through, so no click-through is claimed. |
| R-36/R-38 claims | PASS | Copy describes only implemented behavior. |
| R-39 semantics | PASS | Error fallback uses a labelled `<section>`, an `h1` with matching id, and native button and link controls. |
