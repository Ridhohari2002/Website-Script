-- ---------------------------------------------------------------------------
-- Executor-first license architecture.
--
-- Adds the product/entitlement model, immutable purchase identity, executor
-- sessions, nonce replay storage, and the traceability columns needed by the
-- executor API and dashboard. Additive only: no existing row is deleted and no
-- existing column is dropped.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Products and script entitlement
-- ---------------------------------------------------------------------------

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_code_key unique (code)
);

create table if not exists product_scripts (
  product_id uuid not null references products (id) on delete cascade,
  script_id uuid not null references scripts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, script_id)
);
create index if not exists product_scripts_script_id_idx on product_scripts (script_id);

create table if not exists key_entitlements (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  product_id uuid not null references products (id) on delete restrict,
  source text not null default 'manual',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint key_entitlements_source_check check (
    source in ('purchase', 'admin', 'legacy', 'manual')
  ),
  constraint key_entitlements_status_check check (
    status in ('active', 'suspended', 'expired', 'revoked')
  ),
  constraint key_entitlements_key_product_key unique (key_id, product_id),
  constraint key_entitlements_expiry_check check (expires_at is null or expires_at > starts_at)
);
create index if not exists key_entitlements_key_id_idx on key_entitlements (key_id);
create index if not exists key_entitlements_product_id_idx on key_entitlements (product_id);
create index if not exists key_entitlements_expires_at_idx on key_entitlements (expires_at);

-- ---------------------------------------------------------------------------
-- Immutable buyer / purchase identity
-- ---------------------------------------------------------------------------

create table if not exists key_purchases (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  buyer_discord_id text not null,
  buyer_discord_username text,
  purchase_reference text,
  product_id uuid references products (id),
  payment_status text not null default 'paid',
  source text not null default 'purchase',
  purchased_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint key_purchases_key_key unique (key_id),
  constraint key_purchases_payment_status_check check (
    payment_status in ('pending', 'paid', 'failed', 'refunded', 'free', 'legacy')
  ),
  constraint key_purchases_source_check check (
    source in ('purchase', 'admin', 'legacy', 'free')
  )
);
create index if not exists key_purchases_buyer_discord_id_idx
  on key_purchases (buyer_discord_id);
create index if not exists key_purchases_product_id_idx on key_purchases (product_id);

-- ---------------------------------------------------------------------------
-- Key claim and hash-version metadata
-- ---------------------------------------------------------------------------

alter table keys add column if not exists product_id uuid references products (id);
alter table keys add column if not exists claimed_at timestamptz;
alter table keys add column if not exists claim_kind text;
alter table keys add column if not exists claim_ref text;
alter table keys add column if not exists key_hash_version text not null default 'v1';

alter table keys
  add constraint keys_claim_kind_check
  check (claim_kind is null or claim_kind in ('executor', 'discord'));

alter table keys
  add constraint keys_key_hash_version_check
  check (key_hash_version in ('v1', 'v2'));

create index if not exists keys_product_id_idx on keys (product_id);
create index if not exists keys_claim_kind_idx on keys (claim_kind);

-- Existing web key sessions keep their v1 hashes. New executor sessions use
-- the dedicated key secret and record their own version.
alter table key_sessions
  add column if not exists session_token_hash_version text not null default 'v1';

alter table key_sessions
  add constraint key_sessions_token_hash_version_check
  check (session_token_hash_version in ('v1', 'v2'));

-- ---------------------------------------------------------------------------
-- Executor sessions
-- ---------------------------------------------------------------------------

create table if not exists executor_sessions (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  session_token_hash text not null,
  session_token_hash_version text not null default 'v2',
  hwid_hash text not null,
  hwid_fingerprint text not null,
  status text not null default 'active',
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  roblox_user_id text,
  roblox_username text,
  executor_name text,
  executor_version text,
  client_version text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint executor_sessions_token_hash_key unique (session_token_hash),
  constraint executor_sessions_status_check check (
    status in ('active', 'superseded', 'expired', 'revoked')
  ),
  constraint executor_sessions_hash_version_check check (
    session_token_hash_version in ('v1', 'v2')
  ),
  constraint executor_sessions_expiry_check check (
    absolute_expires_at > created_at and idle_expires_at > created_at
  )
);
create unique index if not exists executor_sessions_one_active_per_key
  on executor_sessions (key_id) where status = 'active';
create index if not exists executor_sessions_key_id_idx on executor_sessions (key_id);
create index if not exists executor_sessions_idle_expires_at_idx
  on executor_sessions (idle_expires_at);
create index if not exists executor_sessions_absolute_expires_at_idx
  on executor_sessions (absolute_expires_at);

-- ---------------------------------------------------------------------------
-- Nonce replay protection
-- ---------------------------------------------------------------------------

create table if not exists executor_nonces (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null,
  session_id uuid not null references executor_sessions (id) on delete cascade,
  key_id uuid not null references keys (id) on delete cascade,
  used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint executor_nonces_hash_key unique (nonce_hash)
);
create index if not exists executor_nonces_expires_at_idx on executor_nonces (expires_at);
create index if not exists executor_nonces_session_id_idx on executor_nonces (session_id);

-- ---------------------------------------------------------------------------
-- Traceability for access and audit records
-- ---------------------------------------------------------------------------

alter table script_access_logs
  add column if not exists executor_session_id uuid references executor_sessions (id) on delete set null;
alter table script_access_logs
  add column if not exists key_session_id uuid references key_sessions (id) on delete set null;
alter table script_access_logs
  add column if not exists entitlement_id uuid references key_entitlements (id) on delete set null;
alter table script_access_logs
  add column if not exists denial_code text;
alter table script_access_logs
  add column if not exists grant_expires_at timestamptz;

create index if not exists script_access_logs_executor_session_id_idx
  on script_access_logs (executor_session_id);
create index if not exists script_access_logs_key_session_id_idx
  on script_access_logs (key_session_id);

alter table audit_logs add column if not exists actor_type text;
alter table audit_logs add column if not exists actor_ref text;
create index if not exists audit_logs_actor_type_idx on audit_logs (actor_type);

-- ---------------------------------------------------------------------------
-- Device history events. Existing values are preserved; executor events are
-- appended so the dashboard can distinguish activation, replacement, and
-- validation failures.
-- ---------------------------------------------------------------------------

alter table key_device_history
  drop constraint if exists key_device_history_event_check;
alter table key_device_history
  add constraint key_device_history_event_check check (
    event in (
      'bound',
      'validation_failed',
      'reset_self',
      'reset_admin',
      'revoked',
      'banned',
      'ban_reversed',
      'executor_activated',
      'executor_reactivated',
      'executor_session_replaced',
      'executor_validation_failed',
      'executor_session_revoked'
    )
  );

-- ---------------------------------------------------------------------------
-- Legacy backfill
--
-- The legacy product intentionally has no product_scripts rows. Existing keys
-- receive an explicit legacy entitlement, but no script access is invented.
-- An owner-approved mapping must be inserted before legacy keys can validate.
-- ---------------------------------------------------------------------------

insert into products (code, name, description, active)
values (
  'legacy',
  'Legacy access',
  'Pre-executor licenses. Script access requires an explicit product_scripts mapping.',
  true
)
on conflict (code) do nothing;

insert into key_entitlements (key_id, product_id, source, status)
select k.id, p.id, 'legacy', 'active'
from keys k
cross join products p
where p.code = 'legacy'
on conflict (key_id, product_id) do nothing;

update keys
set product_id = p.id
from products p
where p.code = 'legacy' and keys.product_id is null;

insert into key_purchases (
  key_id,
  buyer_discord_id,
  buyer_discord_username,
  product_id,
  payment_status,
  source,
  purchased_at
)
select
  k.id,
  k.owner_discord_id,
  u.username,
  p.id,
  'legacy',
  'legacy',
  k.created_at
from keys k
left join users u on u.id = k.user_id
cross join products p
where p.code = 'legacy' and k.owner_discord_id is not null
on conflict (key_id) do nothing;

update keys
set
  claimed_at = coalesce(claimed_at, hwid_bound_at, created_at),
  claim_kind = 'discord'
where owner_discord_id is not null and claim_kind is null;

-- ---------------------------------------------------------------------------
-- RLS: enabled on new tables, default deny, no client policy.
-- ---------------------------------------------------------------------------

do $$
declare
  tbl record;
begin
  for tbl in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', tbl.tablename);
  end loop;
end $$;
