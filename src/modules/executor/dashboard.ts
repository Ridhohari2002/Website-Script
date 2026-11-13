import type { DbExecutor } from "@/db/client";

/**
 * Read models for the dashboard. Buyer/purchase data and executor telemetry are
 * returned as separate fields so the UI never conflates the person who paid
 * with the person currently running the license.
 */

export interface LicenseSummary {
  keyId: string;
  keyPrefix: string | null;
  status: string;
  productCode: string | null;
  productName: string | null;
  maxActivations: number;
  activationCount: number;
  claimedAt: string | null;
  expiresAt: string | null;
  buyerDiscordId: string | null;
  buyerDiscordUsername: string | null;
  paymentStatus: string | null;
  purchaseReference: string | null;
  purchasedAt: string | null;
  executor: {
    sessionId: string;
    status: string;
    robloxUserId: string | null;
    robloxUsername: string | null;
    executorName: string | null;
    executorVersion: string | null;
    hwidFingerprint: string;
    firstActivatedAt: string;
    lastActivityAt: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  } | null;
}

export interface LicenseSession extends NonNullable<LicenseSummary["executor"]> {
  revokedAt: string | null;
}

export interface LicenseEntitlement {
  id: string;
  productCode: string;
  productName: string;
  status: string;
  source: string;
  startsAt: string;
  expiresAt: string | null;
  scripts: { publicId: string; name: string; status: string }[];
}

export interface DeviceEvent {
  event: string;
  hwidFingerprint: string | null;
  createdAt: string;
  actor: string;
}

export interface AuditEvent {
  action: string;
  actorType: string | null;
  createdAt: string;
  metadata: unknown;
}

export interface LicenseDetail {
  license: LicenseSummary;
  sessions: LicenseSession[];
  entitlements: LicenseEntitlement[];
  devices: DeviceEvent[];
  audit: AuditEvent[];
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const LICENSE_SELECT = `
  select
    k.id as key_id,
    k.key_prefix,
    k.status,
    k.max_activations,
    k.activation_count,
    k.claimed_at,
    k.expires_at,
    k.created_at,
    p.code as product_code,
    p.name as product_name,
    kp.buyer_discord_id,
    kp.buyer_discord_username,
    kp.payment_status,
    kp.purchase_reference,
    kp.purchased_at,
    es.id as session_id,
    es.status as session_status,
    es.roblox_user_id,
    es.roblox_username,
    es.executor_name,
    es.executor_version,
    es.hwid_fingerprint,
    es.created_at as session_created_at,
    es.last_seen_at,
    es.idle_expires_at,
    es.absolute_expires_at
  from keys k
  left join products p on p.id = k.product_id
  left join key_purchases kp on kp.key_id = k.id
  left join executor_sessions es on es.id = (
    select x.id from executor_sessions x
     where x.key_id = k.id
     order by (x.status = 'active') desc, x.created_at desc
     limit 1
  )
`;

interface LicenseRow {
  key_id: string;
  key_prefix: string | null;
  status: string;
  max_activations: number;
  activation_count: number;
  claimed_at: Date | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  product_code: string | null;
  product_name: string | null;
  buyer_discord_id: string | null;
  buyer_discord_username: string | null;
  payment_status: string | null;
  purchase_reference: string | null;
  purchased_at: Date | string | null;
  session_id: string | null;
  session_status: string | null;
  roblox_user_id: string | null;
  roblox_username: string | null;
  executor_name: string | null;
  executor_version: string | null;
  hwid_fingerprint: string | null;
  session_created_at: Date | string | null;
  last_seen_at: Date | string | null;
  idle_expires_at: Date | string | null;
  absolute_expires_at: Date | string | null;
}

function projectLicense(row: LicenseRow): LicenseSummary {
  return {
    keyId: row.key_id,
    keyPrefix: row.key_prefix,
    status: row.status,
    productCode: row.product_code,
    productName: row.product_name,
    maxActivations: row.max_activations,
    activationCount: row.activation_count,
    claimedAt: iso(row.claimed_at),
    expiresAt: iso(row.expires_at),
    buyerDiscordId: row.buyer_discord_id,
    buyerDiscordUsername: row.buyer_discord_username,
    paymentStatus: row.payment_status,
    purchaseReference: row.purchase_reference,
    purchasedAt: iso(row.purchased_at),
    executor:
      row.session_id && row.hwid_fingerprint
        ? {
            sessionId: row.session_id,
            status: row.session_status ?? "unknown",
            robloxUserId: row.roblox_user_id,
            robloxUsername: row.roblox_username,
            executorName: row.executor_name,
            executorVersion: row.executor_version,
            hwidFingerprint: row.hwid_fingerprint,
            firstActivatedAt: iso(row.session_created_at) ?? "",
            lastActivityAt: iso(row.last_seen_at) ?? "",
            idleExpiresAt: iso(row.idle_expires_at) ?? "",
            absoluteExpiresAt: iso(row.absolute_expires_at) ?? "",
          }
        : null,
  };
}

export async function listLicenses(
  db: DbExecutor,
  filter: { discordId: string; all: boolean },
): Promise<LicenseSummary[]> {
  const where = filter.all ? "" : "where k.owner_discord_id = $1 or kp.buyer_discord_id = $1";
  const params = filter.all ? [] : [filter.discordId];
  const result = await db.query<LicenseRow>(
    `${LICENSE_SELECT} ${where} order by k.created_at desc, k.id desc`,
    params,
  );
  return result.rows.map(projectLicense);
}

export async function getLicenseDetail(
  db: DbExecutor,
  keyId: string,
): Promise<LicenseDetail | null> {
  const licenseResult = await db.query<LicenseRow>(`${LICENSE_SELECT} where k.id = $1`, [keyId]);
  const row = licenseResult.rows[0];
  if (!row) return null;

  const sessions = await db.query<{
    id: string;
    status: string;
    roblox_user_id: string | null;
    roblox_username: string | null;
    executor_name: string | null;
    executor_version: string | null;
    hwid_fingerprint: string;
    created_at: Date | string;
    last_seen_at: Date | string;
    idle_expires_at: Date | string;
    absolute_expires_at: Date | string;
    revoked_at: Date | string | null;
  }>(
    `select id, status, roblox_user_id, roblox_username, executor_name, executor_version,
            hwid_fingerprint, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
       from executor_sessions
      where key_id = $1
      order by created_at desc, id desc`,
    [keyId],
  );

  const entitlements = await db.query<{
    id: string;
    product_code: string;
    product_name: string;
    status: string;
    source: string;
    starts_at: Date | string;
    expires_at: Date | string | null;
    scripts: { publicId: string; name: string; status: string }[] | null;
  }>(
    `select ke.id, p.code as product_code, p.name as product_name, ke.status, ke.source,
            ke.starts_at, ke.expires_at,
            coalesce(
              json_agg(json_build_object('publicId', s.public_id, 'name', s.name, 'status', s.status))
                filter (where s.id is not null),
              '[]'::json
            ) as scripts
       from key_entitlements ke
       join products p on p.id = ke.product_id
       left join product_scripts ps on ps.product_id = p.id
       left join scripts s on s.id = ps.script_id
      where ke.key_id = $1
      group by ke.id, p.code, p.name
      order by p.code`,
    [keyId],
  );

  const devices = await db.query<{
    event: string;
    hwid_fingerprint: string | null;
    created_at: Date | string;
    actor_user_id: string | null;
    actor_admin_id: string | null;
  }>(
    `select event, hwid_fingerprint, created_at, actor_user_id, actor_admin_id
       from key_device_history
      where key_id = $1
      order by created_at desc, id desc`,
    [keyId],
  );

  const audit = await db.query<{
    action: string;
    actor_type: string | null;
    created_at: Date | string;
    metadata: unknown;
  }>(
    `select action, actor_type, created_at, metadata
       from audit_logs
      where target_type = 'key' and target_id = $1
      order by created_at desc, id desc
      limit 50`,
    [keyId],
  );

  return {
    license: projectLicense(row),
    sessions: sessions.rows.map((session) => ({
      sessionId: session.id,
      status: session.status,
      robloxUserId: session.roblox_user_id,
      robloxUsername: session.roblox_username,
      executorName: session.executor_name,
      executorVersion: session.executor_version,
      hwidFingerprint: session.hwid_fingerprint,
      firstActivatedAt: iso(session.created_at) ?? "",
      lastActivityAt: iso(session.last_seen_at) ?? "",
      idleExpiresAt: iso(session.idle_expires_at) ?? "",
      absoluteExpiresAt: iso(session.absolute_expires_at) ?? "",
      revokedAt: iso(session.revoked_at),
    })),
    entitlements: entitlements.rows.map((entitlement) => ({
      id: entitlement.id,
      productCode: entitlement.product_code,
      productName: entitlement.product_name,
      status: entitlement.status,
      source: entitlement.source,
      startsAt: iso(entitlement.starts_at) ?? "",
      expiresAt: iso(entitlement.expires_at),
      scripts: entitlement.scripts ?? [],
    })),
    devices: devices.rows.map((device) => ({
      event: device.event,
      hwidFingerprint: device.hwid_fingerprint,
      createdAt: iso(device.created_at) ?? "",
      actor: device.actor_admin_id ? "admin" : device.actor_user_id ? "user" : "system",
    })),
    audit: audit.rows.map((event) => ({
      action: event.action,
      actorType: event.actor_type,
      createdAt: iso(event.created_at) ?? "",
      metadata: event.metadata,
    })),
  };
}
