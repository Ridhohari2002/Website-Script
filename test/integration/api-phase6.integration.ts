import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import type { RateLimitDecision, RateLimitDimension, RateLimiter } from "@/db/rate-limit-store";
import { createLogger } from "@/core/logger";
import { createApiHandler } from "@/http/app";
import type { RouteDefinition } from "@/http/router";
import { CSRF_COOKIE, OAUTH_STATE_COOKIE, SESSION_COOKIE } from "@/modules/auth/config";
import type { AuthService } from "@/modules/auth/service";
import { createAuthService } from "@/modules/auth/service";
import { getLicenseDetail } from "@/modules/executor/dashboard";
import type { ExecutorService, ExecutorServiceDeps } from "@/modules/executor/service";
import { createExecutorService } from "@/modules/executor/service";
import type { KeyService } from "@/modules/keys/service";
import { createKeyService } from "@/modules/keys/service";
import { createRoutes } from "@/routes";
import {
  cookieValue,
  createMockDiscord,
  FakeClock,
  setCookieFor,
  TEST_CONFIG,
  TEST_SESSION_SECRET,
  type MockDiscord,
} from "../helpers/auth";
import {
  entitleKey,
  seedScript,
  TEST_HWID_SECRET,
  TEST_KEY_SECRET,
  TEST_KEY_SESSION_SECRET,
} from "../helpers/keys";
import { createPgTestDatabase, type PgTestDatabase } from "../helpers/pg-db";

/**
 * Phase 6 route-level integration suite.
 *
 * Everything goes through the real request pipeline and the real PostgreSQL
 * services. Only the two external boundaries are replaced: the Discord OAuth
 * client (a deterministic in-process fake) and the rate-limit store (an
 * in-memory limiter). Ownership, locking, CSRF, session resolution, auditing,
 * and entitlement checks are exercised as shipped.
 */

const BASE = "http://localhost:3000";
const ORIGIN = BASE;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type Handler = (request: Request, path: readonly string[]) => Promise<Response>;

interface ControllableLimiter extends RateLimiter {
  calls: RateLimitDimension[][];
  state: { allowed: boolean; retryAfterSeconds: number };
}

function createControllableLimiter(): ControllableLimiter {
  const limiter: ControllableLimiter = {
    calls: [],
    state: { allowed: true, retryAfterSeconds: 3 },
    async consume(dimensions): Promise<RateLimitDecision> {
      limiter.calls.push([...dimensions]);
      if (limiter.state.allowed) return { allowed: true, retryAfterSeconds: 0 };
      return {
        allowed: false,
        retryAfterSeconds: limiter.state.retryAfterSeconds,
        exceeded: dimensions[0]?.kind ?? "ip",
      };
    },
  };
  return limiter;
}

interface Phase6Harness {
  pg: PgTestDatabase;
  db: Db;
  clock: FakeClock;
  discord: MockDiscord;
  auth: AuthService;
  keys: KeyService;
  executor: ExecutorService;
  executorDeps: ExecutorServiceDeps;
  routeLimiter: ControllableLimiter;
  serviceLimiter: ControllableLimiter;
  handle: Handler;
  buildHandler(executor?: ExecutorService): Handler;
}

interface TestSession {
  discordId: string;
  username: string;
  userId: string;
  cookie: string;
  csrf: string;
  session: string;
}

interface GeneratedKeyBody {
  keyId: string;
  key: string;
  keyPrefix: string;
  status: string;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

interface SessionSummary {
  id: string;
  current: boolean;
}

interface ExecutorActivationResponse {
  keyId: string;
  sessionId: string;
  sessionToken: string;
  status: string;
  firstClaim: boolean;
  activationCount: number;
  scriptId: string;
  entitlementId: string;
  productId: string;
}

interface ExecutorValidationResponse {
  valid: boolean;
  scriptId: string;
  keyId: string;
  sessionId: string;
  grantId: string;
}

function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

function newDiscordId(): string {
  let digits = "9";
  for (let index = 0; index < 17; index += 1) digits += String(randomInt(0, 10));
  return digits;
}

const testLogger = createLogger({ level: "error", sink: () => undefined });

let harnessValue: Phase6Harness;

function harness(): Phase6Harness {
  return harnessValue;
}

beforeAll(async () => {
  const pg = await createPgTestDatabase({ applicationName: "boyfinity-phase6-api-test" });
  const clock = new FakeClock();
  const discord = createMockDiscord();
  const routeLimiter = createControllableLimiter();
  const serviceLimiter = createControllableLimiter();

  const auth = createAuthService({
    db: pg.db,
    clock: clock.now,
    discord: discord.client,
    config: TEST_CONFIG,
    sessionSecret: TEST_SESSION_SECRET,
    secureCookies: false,
    ownerDiscordId: null,
    logger: testLogger,
  });

  const executorDeps: ExecutorServiceDeps = {
    db: pg.db,
    clock: clock.now,
    sessionSecret: TEST_KEY_SESSION_SECRET,
    keySecret: TEST_KEY_SECRET,
    keySecretVersion: "v2",
    hwidSecret: TEST_HWID_SECRET,
    limiter: serviceLimiter,
  };
  const keys = createKeyService({
    db: pg.db,
    clock: clock.now,
    sessionSecret: TEST_KEY_SESSION_SECRET,
    keySecret: TEST_KEY_SECRET,
    keySecretVersion: "v2",
    hwidSecret: TEST_HWID_SECRET,
  });
  const executor = createExecutorService(executorDeps);

  const buildHandler = (executorOverride?: ExecutorService): Handler => {
    const routes: RouteDefinition[] = createRoutes({
      auth,
      keys,
      executor: executorOverride ?? executor,
      checkDatabase: async () => true,
    });
    return createApiHandler(routes, {
      logger: testLogger,
      limiter: routeLimiter,
      resolveSession: (request) => auth.resolveSession(request),
      csrfOrigins: [ORIGIN],
      auditDenial: (event) => auth.recordAuthorizationDenied(event),
    });
  };

  harnessValue = {
    pg,
    db: pg.db,
    clock,
    discord,
    auth,
    keys,
    executor,
    executorDeps,
    routeLimiter,
    serviceLimiter,
    handle: buildHandler(),
    buildHandler,
  };
});

afterAll(async () => {
  await harnessValue.pg.close();
});

beforeEach(() => {
  harnessValue.routeLimiter.calls.length = 0;
  harnessValue.routeLimiter.state.allowed = true;
  harnessValue.serviceLimiter.calls.length = 0;
  harnessValue.serviceLimiter.state.allowed = true;
});

interface ApiOptions {
  method?: string;
  cookie?: string;
  csrf?: string;
  origin?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function api(handler: Handler, path: string, options: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": BROWSER_UA, ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  if (options.origin) headers.origin = options.origin;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const [pathnamePart] = path.split("?");
  const pathname = pathnamePart ?? "";
  const segments = pathname
    .replace(/^\/api\//, "")
    .split("/")
    .filter(Boolean);
  const request = new Request(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return handler(request, segments);
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function loginAs(
  discordId = newDiscordId(),
  username = `phase6-${uniqueSuffix()}`,
): Promise<TestSession> {
  const h = harness();
  h.discord.profile.id = discordId;
  h.discord.profile.username = username;
  h.discord.profile.globalName = username;

  const login = await api(h.handle, "/api/auth/login?next=/dashboard");
  expect(login.status).toBe(302);
  const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE);
  expect(state).toBeTruthy();

  const callback = await api(
    h.handle,
    `/api/auth/callback?code=test-code&state=${encodeURIComponent(state!)}`,
    { headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` } },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(`${BASE}/dashboard`);

  const setCookies = callback.headers.getSetCookie();
  const session = cookieValue(setCookies, SESSION_COOKIE);
  const csrf = cookieValue(setCookies, CSRF_COOKIE);
  expect(session).toBeTruthy();
  expect(csrf).toBeTruthy();

  const sessionResponse = await api(h.handle, "/api/auth/session", {
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  expect(sessionResponse.status).toBe(200);
  const sessionBody = await readJson<{
    user: { id: string; discordId: string; username: string | null };
  }>(sessionResponse);
  expect(sessionBody.user.discordId).toBe(discordId);

  return {
    discordId,
    username,
    userId: sessionBody.user.id,
    cookie: `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`,
    csrf: csrf!,
    session: session!,
  };
}

async function promoteToAdmin(userId: string): Promise<void> {
  await harness().db.query(
    "insert into user_roles (user_id, role) values ($1, 'admin') on conflict do nothing",
    [userId],
  );
}

async function loginAsAdmin(): Promise<TestSession> {
  const session = await loginAs();
  await promoteToAdmin(session.userId);
  return session;
}

async function generateKey(
  admin: TestSession,
  overrides: Record<string, unknown> = {},
): Promise<GeneratedKeyBody> {
  const response = await api(harness().handle, "/api/admin/keys", {
    method: "POST",
    cookie: admin.cookie,
    csrf: admin.csrf,
    origin: ORIGIN,
    body: { count: 1, type: "paid", maxActivations: 1, ...overrides },
  });
  expect(response.status).toBe(201);
  const body = await readJson<{ keys: GeneratedKeyBody[] }>(response);
  expect(body.keys).toHaveLength(1);
  return body.keys[0]!;
}

interface EntitledFixture {
  keyId: string;
  key: string;
  publicId: string;
  scriptId: string;
}

async function createEntitledKey(
  admin: TestSession,
  options: { publicId?: string; maxActivations?: number } = {},
): Promise<EntitledFixture> {
  const h = harness();
  const publicId = options.publicId ?? `phase6-script-${uniqueSuffix()}`;
  const scriptId = await seedScript(h.db, { publicId });
  const generated = await generateKey(admin, {
    ...(options.maxActivations ? { maxActivations: options.maxActivations } : {}),
  });
  await entitleKey(h.db, generated.keyId);
  return { keyId: generated.keyId, key: generated.key, publicId, scriptId };
}

function activate(
  handler: Handler,
  input: { key: string; hwid: string; scriptId: string; headers?: Record<string, string> },
): Promise<Response> {
  return api(handler, "/api/executor/v1/activate", {
    method: "POST",
    body: { key: input.key, hwid: input.hwid, scriptId: input.scriptId },
    ...(input.headers ? { headers: input.headers } : {}),
  });
}

function validateRequest(
  handler: Handler,
  input: {
    token: string;
    hwid: string;
    scriptId: string;
    nonce?: string;
    timestamp?: string | number;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    ...input.headers,
  };
  return api(handler, "/api/executor/v1/validate", {
    method: "POST",
    headers,
    body: {
      scriptId: input.scriptId,
      hwid: input.hwid,
      timestamp: input.timestamp ?? harness().clock.now().toISOString(),
      nonce: input.nonce ?? randomUUID(),
    },
  });
}

function revokeWithToken(handler: Handler, token: string): Promise<Response> {
  return api(handler, "/api/executor/v1/session/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

function expectRequestId(response: Response, expected?: string): void {
  const id = response.headers.get("x-request-id");
  expect(id).toBeTruthy();
  if (expected) expect(id).toBe(expected);
}

async function auditRows(
  action: string,
  targetId: string,
): Promise<
  Array<{
    actor_user_id: string | null;
    actor_type: string | null;
    actor_ref: string | null;
    metadata: unknown;
  }>
> {
  const result = await harness().db.query<{
    actor_user_id: string | null;
    actor_type: string | null;
    actor_ref: string | null;
    metadata: unknown;
  }>(
    `select actor_user_id, actor_type, actor_ref, metadata from audit_logs
      where action = $1 and target_id = $2
      order by created_at desc`,
    [action, targetId],
  );
  return result.rows;
}

describe("Phase 6 API integration on real PostgreSQL", () => {
  it("runs Discord OAuth login and session resolution through the real pipeline", async () => {
    const h = harness();
    const discordId = newDiscordId();
    h.discord.profile.id = discordId;
    h.discord.profile.username = "phase6-login";

    const login = await api(h.handle, "/api/auth/login?next=/dashboard", {
      headers: { "x-request-id": "phase6-login-start" },
    });
    expect(login.status).toBe(302);
    expectRequestId(login, "phase6-login-start");
    const location = login.headers.get("location") ?? "";
    expect(location.startsWith("https://discord.com/api/oauth2/authorize?")).toBe(true);
    expect(location).toContain("code_challenge=");

    const state = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE);
    expect(state).toBeTruthy();
    const stateLine = setCookieFor(login.headers.getSetCookie(), OAUTH_STATE_COOKIE);
    expect(stateLine).toContain("HttpOnly");

    const callback = await api(
      h.handle,
      `/api/auth/callback?code=test-code&state=${encodeURIComponent(state!)}`,
      {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${state}`,
          "x-request-id": "phase6-login-callback",
        },
      },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${BASE}/dashboard`);
    expectRequestId(callback, "phase6-login-callback");

    const setCookies = callback.headers.getSetCookie();
    const session = cookieValue(setCookies, SESSION_COOKIE);
    const csrf = cookieValue(setCookies, CSRF_COOKIE);
    expect(session).toBeTruthy();
    expect(csrf).toBeTruthy();
    const sessionLine = setCookieFor(setCookies, SESSION_COOKIE) ?? "";
    expect(sessionLine).toContain("HttpOnly");
    expect(sessionLine).toContain("SameSite=Lax");
    expect(sessionLine).toContain("Path=/");
    expect(sessionLine).not.toContain("Secure");

    const sessionResponse = await api(h.handle, "/api/auth/session", {
      cookie: `${SESSION_COOKIE}=${session}`,
    });
    expect(sessionResponse.status).toBe(200);
    expectRequestId(sessionResponse);
    const sessionBody = await readJson<{
      user: { discordId: string };
      roles: string[];
      csrfToken: string;
    }>(sessionResponse);
    expect(sessionBody.user.discordId).toBe(discordId);
    expect(sessionBody.roles).toContain("user");
    expect(sessionBody.csrfToken).toBe(csrf);

    const reusedState = await api(
      h.handle,
      "/api/auth/callback?code=test-code&state=unknown-state",
      { headers: { cookie: `${OAUTH_STATE_COOKIE}=unknown-state` } },
    );
    expect(reusedState.status).toBe(302);
    expect(reusedState.headers.get("location")).toBe(`${BASE}/?auth_error=invalid_state`);
    expectRequestId(reusedState);
  });

  it("denies protected routes without a session and keeps a request id on errors", async () => {
    const response = await api(harness().handle, "/api/auth/sessions", {
      headers: { "x-request-id": "phase6-unauthenticated" },
    });
    expect(response.status).toBe(401);
    expectRequestId(response, "phase6-unauthenticated");
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.requestId).toBe("phase6-unauthenticated");
  });

  it("enforces origin and synchronizer-token CSRF, then revokes the session on logout", async () => {
    const h = harness();
    const user = await loginAs();

    const missingToken = await api(h.handle, "/api/auth/logout", {
      method: "POST",
      cookie: user.cookie,
      origin: ORIGIN,
    });
    expect(missingToken.status).toBe(403);
    expect((await readJson<ErrorBody>(missingToken)).error.code).toBe("forbidden");

    const wrongToken = await api(h.handle, "/api/auth/logout", {
      method: "POST",
      cookie: user.cookie,
      origin: ORIGIN,
      csrf: "not-the-session-token",
    });
    expect(wrongToken.status).toBe(403);

    const crossOrigin = await api(h.handle, "/api/auth/logout", {
      method: "POST",
      cookie: user.cookie,
      origin: "https://evil.example",
      csrf: user.csrf,
    });
    expect(crossOrigin.status).toBe(403);

    const logout = await api(h.handle, "/api/auth/logout", {
      method: "POST",
      cookie: user.cookie,
      origin: ORIGIN,
      csrf: user.csrf,
    });
    expect(logout.status).toBe(200);
    expectRequestId(logout);
    expect(setCookieFor(logout.headers.getSetCookie(), SESSION_COOKIE)).toContain("Max-Age=0");

    const after = await api(h.handle, "/api/auth/session", { cookie: user.cookie });
    expect(after.status).toBe(401);

    const audit = await h.db.query<{ actor_user_id: string | null }>(
      `select actor_user_id from audit_logs
        where action = 'auth.logout' and actor_user_id = $1
        order by created_at desc`,
      [user.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_user_id).toBe(user.userId);
  });

  it("rejects a non-admin with 403 and writes the authorization-denied audit record", async () => {
    const h = harness();
    const user = await loginAs();

    const response = await api(h.handle, "/api/admin/keys", {
      cookie: user.cookie,
      headers: { "x-request-id": "phase6-admin-denied" },
    });
    expect(response.status).toBe(403);
    expectRequestId(response, "phase6-admin-denied");
    expect((await readJson<ErrorBody>(response)).error.code).toBe("forbidden");

    const audit = await auditRows("auth.authorization_denied", "/api/admin/keys");
    const row = audit.find((entry) => entry.actor_user_id === user.userId);
    expect(row).toBeTruthy();
    expect((row!.metadata as { requestId?: string }).requestId).toBe("phase6-admin-denied");
  });

  it("lists and revokes account sessions through the API", async () => {
    const h = harness();
    const first = await loginAsAdmin();
    const second = await loginAs(first.discordId, first.username);

    const listed = await api(h.handle, "/api/auth/sessions", { cookie: second.cookie });
    expect(listed.status).toBe(200);
    const sessions = await readJson<{ sessions: SessionSummary[] }>(listed);
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions.filter((entry) => entry.current)).toHaveLength(1);

    const current = sessions.sessions.find((entry) => entry.current)!;
    const other = sessions.sessions.find((entry) => !entry.current)!;

    const revokeOther = await api(h.handle, `/api/auth/sessions/${other.id}`, {
      method: "DELETE",
      cookie: second.cookie,
      origin: ORIGIN,
      csrf: second.csrf,
    });
    expect(revokeOther.status).toBe(200);
    const revokedOther = await readJson<{ ok: boolean; current: boolean }>(revokeOther);
    expect(revokedOther.ok).toBe(true);
    expect(revokedOther.current).toBe(false);

    const stale = await api(h.handle, "/api/auth/session", { cookie: first.cookie });
    expect(stale.status).toBe(401);

    const revokeCurrent = await api(h.handle, `/api/auth/sessions/${current.id}`, {
      method: "DELETE",
      cookie: second.cookie,
      origin: ORIGIN,
      csrf: second.csrf,
    });
    expect(revokeCurrent.status).toBe(200);
    expect((await readJson<{ current: boolean }>(revokeCurrent)).current).toBe(true);
    expect(setCookieFor(revokeCurrent.headers.getSetCookie(), SESSION_COOKIE)).toContain(
      "Max-Age=0",
    );

    const after = await api(h.handle, "/api/auth/session", { cookie: second.cookie });
    expect(after.status).toBe(401);

    const audit = await harness().db.query<{ count: number }>(
      `select count(*)::int as count from audit_logs
        where action = 'auth.session_revoked' and actor_user_id = $1`,
      [first.userId],
    );
    expect(audit.rows[0]!.count).toBe(2);
  });

  it("keeps keys owner-scoped: another user cannot read a key's usage", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const alice = await loginAs();
    const bob = await loginAs();

    const generated = await generateKey(admin);
    await h.db.query("update keys set owner_discord_id = $2 where id = $1", [
      generated.keyId,
      alice.discordId,
    ]);

    const aliceKeys = await api(h.handle, "/api/keys/me", { cookie: alice.cookie });
    expect(aliceKeys.status).toBe(200);
    const aliceList = await readJson<{ keys: Array<{ keyId: string }> }>(aliceKeys);
    expect(aliceList.keys.some((entry) => entry.keyId === generated.keyId)).toBe(true);

    const bobKeys = await api(h.handle, "/api/keys/me", { cookie: bob.cookie });
    const bobList = await readJson<{ keys: Array<{ keyId: string }> }>(bobKeys);
    expect(bobList.keys.some((entry) => entry.keyId === generated.keyId)).toBe(false);

    const usage = await api(h.handle, `/api/keys/${generated.keyId}/usage`, {
      cookie: bob.cookie,
    });
    expect(usage.status).toBe(403);
    expect((await readJson<ErrorBody>(usage)).error.code).toBe("not_owner");
  });

  it("revokes a key as admin and the executor can no longer activate it", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const generated = await generateKey(admin);
    const scriptId = `phase6-revoked-${uniqueSuffix()}`;

    const revoke = await api(h.handle, `/api/admin/keys/${generated.keyId}/revoke`, {
      method: "POST",
      cookie: admin.cookie,
      csrf: admin.csrf,
      origin: ORIGIN,
      body: { reason: "phase 6 integration test" },
    });
    expect(revoke.status).toBe(200);
    const revoked = await readJson<{ keyId: string; status: string }>(revoke);
    expect(revoked.status).toBe("revoked");

    const activation = await activate(h.handle, {
      key: generated.key,
      hwid: `phase6-hwid-${uniqueSuffix()}`,
      scriptId,
    });
    expect(activation.status).toBe(403);
    expect((await readJson<ErrorBody>(activation)).error.code).toBe("revoked_key");

    const audit = await auditRows("key.revoke", generated.keyId);
    expect(audit.length).toBeGreaterThanOrEqual(1);

    const listed = await api(h.handle, "/api/admin/keys?status=revoked", {
      cookie: admin.cookie,
    });
    expect(listed.status).toBe(200);
    const listBody = await readJson<{ keys: Array<{ keyId: string }> }>(listed);
    expect(listBody.keys.some((entry) => entry.keyId === generated.keyId)).toBe(true);
  });

  it("enforces entitlement and script gating before activation", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const publicId = `phase6-gate-${uniqueSuffix()}`;
    await seedScript(h.db, { publicId });
    const generated = await generateKey(admin);
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    const missingEntitlement = await activate(h.handle, {
      key: generated.key,
      hwid,
      scriptId: publicId,
    });
    expect(missingEntitlement.status).toBe(403);
    expect((await readJson<ErrorBody>(missingEntitlement)).error.code).toBe("entitlement_missing");

    await entitleKey(h.db, generated.keyId);
    const granted = await activate(h.handle, { key: generated.key, hwid, scriptId: publicId });
    expect(granted.status).toBe(201);

    const unknownScript = await activate(h.handle, {
      key: generated.key,
      hwid,
      scriptId: `phase6-missing-${uniqueSuffix()}`,
    });
    expect(unknownScript.status).toBe(403);
    expect((await readJson<ErrorBody>(unknownScript)).error.code).toBe("script_not_found");
  });

  it("activates, validates, rejects a replay, and revokes an executor session", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const fixture = await createEntitledKey(admin);
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    const activation = await activate(h.handle, {
      key: fixture.key,
      hwid,
      scriptId: fixture.publicId,
      headers: { "x-request-id": "phase6-activate" },
    });
    expect(activation.status).toBe(201);
    expectRequestId(activation, "phase6-activate");
    const activated = await readJson<ExecutorActivationResponse>(activation);
    expect(activated.keyId).toBe(fixture.keyId);
    expect(activated.status).toBe("active");
    expect(activated.firstClaim).toBe(true);
    expect(activated.activationCount).toBe(1);
    expect(activated.sessionToken.length).toBeGreaterThan(20);

    const stored = await h.db.query<{
      id: string;
      hwid_hash: string;
      hwid_fingerprint: string;
      session_token_hash: string;
    }>(
      "select id, hwid_hash, hwid_fingerprint, session_token_hash from executor_sessions where key_id = $1",
      [fixture.keyId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.id).toBe(activated.sessionId);
    expect(stored.rows[0]!.hwid_hash).not.toBe(hwid);
    expect(stored.rows[0]!.session_token_hash).not.toBe(activated.sessionToken);
    expect(JSON.stringify(stored.rows)).not.toContain(hwid);

    const activationAudit = await auditRows("executor.activate", fixture.keyId);
    expect(activationAudit.length).toBe(1);
    expect(activationAudit[0]!.actor_type).toBe("executor");

    const nonce = randomUUID();
    const validated = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid,
      scriptId: fixture.publicId,
      nonce,
    });
    expect(validated.status).toBe(200);
    const validationBody = await readJson<ExecutorValidationResponse>(validated);
    expect(validationBody.valid).toBe(true);
    expect(validationBody.sessionId).toBe(activated.sessionId);
    expect(validationBody.keyId).toBe(fixture.keyId);

    const replay = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid,
      scriptId: fixture.publicId,
      nonce,
    });
    expect(replay.status).toBe(403);
    expect((await readJson<ErrorBody>(replay)).error.code).toBe("replay_detected");

    const grants = await h.db.query<{ count: number }>(
      "select count(*)::int as count from script_access_logs where key_id = $1",
      [fixture.keyId],
    );
    expect(grants.rows[0]!.count).toBe(1);

    const mismatch = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid: `phase6-other-${uniqueSuffix()}`,
      scriptId: fixture.publicId,
    });
    expect(mismatch.status).toBe(403);
    expect((await readJson<ErrorBody>(mismatch)).error.code).toBe("hwid_mismatch");

    const stale = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid,
      scriptId: fixture.publicId,
      timestamp: "2000-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(403);
    expect((await readJson<ErrorBody>(stale)).error.code).toBe("timestamp_invalid");

    const missingBearer = await api(h.handle, "/api/executor/v1/validate", {
      method: "POST",
      body: { scriptId: fixture.publicId, hwid, timestamp: h.clock.now().toISOString(), nonce },
    });
    expect(missingBearer.status).toBe(400);
    expect((await readJson<ErrorBody>(missingBearer)).error.code).toBe("bad_request");

    const failed = await auditRows("executor.validate_failed", fixture.keyId);
    expect(
      failed.some((entry) => (entry.metadata as { code?: string }).code === "replay_detected"),
    ).toBe(true);

    const revoked = await revokeWithToken(h.handle, activated.sessionToken);
    expect(revoked.status).toBe(200);
    const revokedBody = await readJson<{ outcome: string; revoked: boolean }>(revoked);
    expect(revokedBody.revoked).toBe(true);
    expect(revokedBody.outcome).toBe("revoked");

    const afterRevoke = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(afterRevoke.status).toBe(401);
    expect((await readJson<ErrorBody>(afterRevoke)).error.code).toBe("session_revoked");

    const again = await revokeWithToken(h.handle, activated.sessionToken);
    expect(again.status).toBe(200);
    expect((await readJson<{ outcome: string }>(again)).outcome).toBe("already_revoked");

    const unknown = await revokeWithToken(h.handle, "phase6-unknown-token");
    expect(unknown.status).toBe(401);
    expect((await readJson<ErrorBody>(unknown)).error.code).toBe("session_required");
  });

  it("keeps one active executor session per key and invalidates the superseded one", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const fixture = await createEntitledKey(admin);
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    const first = await readJson<ExecutorActivationResponse>(
      await activate(h.handle, { key: fixture.key, hwid, scriptId: fixture.publicId }),
    );
    const second = await readJson<ExecutorActivationResponse>(
      await activate(h.handle, { key: fixture.key, hwid, scriptId: fixture.publicId }),
    );
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.firstClaim).toBe(false);

    const firstValidation = await validateRequest(h.handle, {
      token: first.sessionToken,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(firstValidation.status).toBe(401);
    expect((await readJson<ErrorBody>(firstValidation)).error.code).toBe("session_revoked");

    const secondValidation = await validateRequest(h.handle, {
      token: second.sessionToken,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(secondValidation.status).toBe(200);

    const sessions = await api(h.handle, `/api/admin/keys/${fixture.keyId}/sessions`, {
      cookie: admin.cookie,
    });
    expect(sessions.status).toBe(200);
    const listed = await readJson<{
      sessions: Array<{ id: string; status: string; hwidFingerprint: string }>;
    }>(sessions);
    expect(listed.sessions.filter((entry) => entry.status === "active")).toHaveLength(1);
    expect(listed.sessions.filter((entry) => entry.status === "superseded")).toHaveLength(1);
    expect(listed.sessions[0]!.hwidFingerprint).not.toBe(hwid);
  });

  it("lets an admin list and revoke an executor session through the API", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const fixture = await createEntitledKey(admin);
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    const activated = await readJson<ExecutorActivationResponse>(
      await activate(h.handle, { key: fixture.key, hwid, scriptId: fixture.publicId }),
    );

    const revoke = await api(
      h.handle,
      `/api/admin/keys/${fixture.keyId}/sessions/${activated.sessionId}/revoke`,
      {
        method: "POST",
        cookie: admin.cookie,
        csrf: admin.csrf,
        origin: ORIGIN,
      },
    );
    expect(revoke.status).toBe(200);
    const revoked = await readJson<{ outcome: string; status: string }>(revoke);
    expect(revoked.outcome).toBe("revoked");
    expect(revoked.status).toBe("revoked");

    const validation = await validateRequest(h.handle, {
      token: activated.sessionToken,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(validation.status).toBe(401);
    expect((await readJson<ErrorBody>(validation)).error.code).toBe("session_revoked");

    const audit = await auditRows("executor.session_revoke_admin", fixture.keyId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(admin.userId);
    expect(audit[0]!.actor_ref).toBe(activated.sessionId);
  });

  it("expires executor sessions on idle and absolute timeouts", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    const idleFixture = await createEntitledKey(admin);
    const idleExecutor = createExecutorService({
      ...h.executorDeps,
      idleMs: 60_000,
      absoluteMs: 120_000,
    });
    const idleHandle = h.buildHandler(idleExecutor);
    const idleSession = await readJson<ExecutorActivationResponse>(
      await activate(idleHandle, {
        key: idleFixture.key,
        hwid,
        scriptId: idleFixture.publicId,
      }),
    );
    h.clock.advance(61_000);
    const idleExpired = await validateRequest(idleHandle, {
      token: idleSession.sessionToken,
      hwid,
      scriptId: idleFixture.publicId,
    });
    expect(idleExpired.status).toBe(401);
    expect((await readJson<ErrorBody>(idleExpired)).error.code).toBe("session_expired");

    const absoluteFixture = await createEntitledKey(admin);
    const absoluteExecutor = createExecutorService({
      ...h.executorDeps,
      idleMs: 600_000,
      absoluteMs: 60_000,
    });
    const absoluteHandle = h.buildHandler(absoluteExecutor);
    const absoluteSession = await readJson<ExecutorActivationResponse>(
      await activate(absoluteHandle, {
        key: absoluteFixture.key,
        hwid,
        scriptId: absoluteFixture.publicId,
      }),
    );
    h.clock.advance(61_000);
    const absoluteExpired = await validateRequest(absoluteHandle, {
      token: absoluteSession.sessionToken,
      hwid,
      scriptId: absoluteFixture.publicId,
    });
    expect(absoluteExpired.status).toBe(401);
    expect((await readJson<ErrorBody>(absoluteExpired)).error.code).toBe("session_expired");

    const expiry = await h.db.query<{ status: string }>(
      "select status from executor_sessions where id = $1",
      [absoluteSession.sessionId],
    );
    expect(expiry.rows[0]!.status).toBe("expired");
  });

  it("denies at the route IP bucket before any executor work runs", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const fixture = await createEntitledKey(admin);
    const hwid = `phase6-hwid-${uniqueSuffix()}`;

    h.routeLimiter.state.allowed = false;
    const denied = await activate(h.handle, {
      key: fixture.key,
      hwid,
      scriptId: fixture.publicId,
      headers: { "x-request-id": "phase6-rate-limited" },
    });
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("3");
    expectRequestId(denied, "phase6-rate-limited");
    expect((await readJson<ErrorBody>(denied)).error.code).toBe("rate_limited");

    const routeCall = h.routeLimiter.calls.at(-1) ?? [];
    expect(routeCall).toHaveLength(1);
    expect(routeCall[0]!.kind).toBe("ip");

    const sessions = await h.db.query<{ count: number }>(
      "select count(*)::int as count from executor_sessions where key_id = $1",
      [fixture.keyId],
    );
    expect(sessions.rows[0]!.count).toBe(0);

    h.routeLimiter.state.allowed = true;
    h.serviceLimiter.state.allowed = false;
    const serviceDenied = await activate(h.handle, {
      key: fixture.key,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(serviceDenied.status).toBe(429);
    expect(h.serviceLimiter.calls.length).toBeGreaterThan(0);

    h.serviceLimiter.state.allowed = true;
    const allowed = await activate(h.handle, {
      key: fixture.key,
      hwid,
      scriptId: fixture.publicId,
    });
    expect(allowed.status).toBe(201);
  });

  it("keeps the buyer and the executor as separate identities", async () => {
    const h = harness();
    const admin = await loginAsAdmin();
    const publicId = `phase6-buyer-${uniqueSuffix()}`;
    await seedScript(h.db, { publicId });
    const generated = await generateKey(admin);
    await entitleKey(h.db, generated.keyId);

    const product = await h.db.query<{ id: string }>("select id from products where code = $1", [
      `product:${publicId}`,
    ]);
    const buyerDiscordId = newDiscordId();
    await h.db.query(
      `insert into key_purchases
         (key_id, buyer_discord_id, buyer_discord_username, purchase_reference, product_id,
          payment_status, source, purchased_at)
       values ($1, $2, $3, $4, $5, 'paid', 'purchase', now())`,
      [generated.keyId, buyerDiscordId, "phase6-buyer", "phase6-reference", product.rows[0]!.id],
    );

    const hwid = `phase6-hwid-${uniqueSuffix()}`;
    const activation = await activate(h.handle, {
      key: generated.key,
      hwid,
      scriptId: publicId,
    });
    expect(activation.status).toBe(201);
    const activated = await readJson<ExecutorActivationResponse>(activation);
    expect(JSON.stringify(activated)).not.toContain(buyerDiscordId);

    const keyRow = await h.db.query<{
      owner_discord_id: string | null;
      user_id: string | null;
      claim_kind: string | null;
    }>("select owner_discord_id, user_id, claim_kind from keys where id = $1", [generated.keyId]);
    expect(keyRow.rows[0]).toEqual({
      owner_discord_id: null,
      user_id: null,
      claim_kind: "executor",
    });

    const purchase = await h.db.query<{ buyer_discord_id: string; payment_status: string }>(
      "select buyer_discord_id, payment_status from key_purchases where key_id = $1",
      [generated.keyId],
    );
    expect(purchase.rows[0]).toEqual({
      buyer_discord_id: buyerDiscordId,
      payment_status: "paid",
    });

    const detail = await getLicenseDetail(h.db, generated.keyId);
    expect(detail).not.toBeNull();
    expect(detail!.license.buyerDiscordId).toBe(buyerDiscordId);
    expect(detail!.license.paymentStatus).toBe("paid");
    expect(detail!.license.executor?.sessionId).toBe(activated.sessionId);
    expect(detail!.license.executor?.hwidFingerprint).not.toBe(hwid);
  });

  it("returns a request id on JSON, error, redirect, and rate-limited responses", async () => {
    const h = harness();

    const health = await api(h.handle, "/api/health", {
      headers: { "x-request-id": "phase6-health" },
    });
    expect(health.status).toBe(200);
    expectRequestId(health, "phase6-health");

    const unauthenticated = await api(h.handle, "/api/auth/session", {
      headers: { "x-request-id": "phase6-unauth" },
    });
    expectRequestId(unauthenticated, "phase6-unauth");

    const redirect = await api(h.handle, "/api/auth/login", {
      headers: { "x-request-id": "phase6-redirect" },
    });
    expect(redirect.status).toBe(302);
    expectRequestId(redirect, "phase6-redirect");

    h.routeLimiter.state.allowed = false;
    const limited = await api(h.handle, "/api/auth/login", {
      headers: { "x-request-id": "phase6-limited" },
    });
    expect(limited.status).toBe(429);
    expectRequestId(limited, "phase6-limited");
  });
});
