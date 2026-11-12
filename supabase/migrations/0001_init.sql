-- BOYFINITY Hub — Phase 1 schema
-- Source of truth: BACKEND.md Section 8.2, plus the approved D2 (oauth_states)
-- and D10/D11 support tables. Reviewed SQL; never generated against production.

-- gen_random_uuid() is a PostgreSQL core function from version 13 onward, so no
-- extension is required on the supported server versions.

-- ---------------------------------------------------------------------------
-- Identity and roles
-- ---------------------------------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  username text,
  avatar_url text,
  email text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_discord_id_key unique (discord_id),
  constraint users_status_check check (status in ('active', 'suspended', 'deleted'))
);
create index if not exists users_status_idx on users (status);

create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  role text not null,
  granted_by uuid references users (id),
  created_at timestamptz not null default now(),
  constraint user_roles_user_role_key unique (user_id, role),
  constraint user_roles_role_check check (role in ('user', 'moderator', 'admin'))
);
create index if not exists user_roles_user_id_idx on user_roles (user_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text,
  description text,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_slug_key unique (slug)
);

create table if not exists scripts (
  id uuid primary key default gen_random_uuid(),
  public_id text not null,
  name text not null,
  description text,
  game_id uuid references games (id),
  current_version_id uuid,
  content_ref text,
  status text not null default 'draft',
  enabled boolean not null default true,
  created_by uuid references users (id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scripts_public_id_key unique (public_id),
  constraint scripts_status_check check (status in ('draft', 'published', 'archived'))
);
create index if not exists scripts_game_id_idx on scripts (game_id);
create index if not exists scripts_status_idx on scripts (status);
create index if not exists scripts_enabled_idx on scripts (enabled);

create table if not exists script_versions (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references scripts (id) on delete cascade,
  version_number integer not null,
  content_ref text not null,
  changelog text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  constraint script_versions_script_version_key unique (script_id, version_number),
  constraint script_versions_version_number_check check (version_number > 0)
);

alter table scripts
  drop constraint if exists scripts_current_version_fk;
alter table scripts
  add constraint scripts_current_version_fk
  foreign key (current_version_id) references script_versions (id);

-- ---------------------------------------------------------------------------
-- Plans, transactions, subscriptions, keys
-- ---------------------------------------------------------------------------

create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  duration_days integer not null,
  price_minor integer not null,
  currency text not null default 'IDR',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plans_code_key unique (code),
  constraint plans_duration_days_check check (duration_days > 0),
  constraint plans_price_minor_check check (price_minor >= 0)
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  plan_id uuid references plans (id),
  provider text not null,
  provider_txn_id text,
  amount_minor integer not null,
  currency text not null default 'IDR',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transactions_provider_txn_key unique (provider, provider_txn_id),
  constraint transactions_status_check check (status in ('pending', 'paid', 'failed', 'refunded')),
  constraint transactions_amount_minor_check check (amount_minor >= 0)
);
create index if not exists transactions_user_id_idx on transactions (user_id);
create index if not exists transactions_status_idx on transactions (status);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  plan_id uuid not null references plans (id),
  transaction_id uuid references transactions (id),
  status text not null default 'pending',
  started_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_status_check check (status in ('pending', 'active', 'expired', 'cancelled'))
);
create index if not exists subscriptions_user_id_idx on subscriptions (user_id);
create index if not exists subscriptions_status_idx on subscriptions (status);
create index if not exists subscriptions_expires_at_idx on subscriptions (expires_at);

create table if not exists keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null,
  key_prefix text,
  type text not null default 'paid',
  status text not null default 'unused',
  owner_discord_id text,
  user_id uuid references users (id),
  bound_hwid_hash text,
  hwid_bound_at timestamptz,
  last_hwid_reset_at timestamptz,
  hwid_reset_count integer not null default 0,
  banned_at timestamptz,
  ban_detected_at timestamptz,
  ban_reason text,
  ban_evidence_refs jsonb,
  subscription_id uuid references subscriptions (id),
  plan_id uuid references plans (id),
  max_activations integer not null default 1,
  activation_count integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint keys_key_hash_key unique (key_hash),
  constraint keys_type_check check (type in ('free', 'paid')),
  constraint keys_status_check check (
    status in ('unused', 'active', 'expired', 'revoked', 'suspended', 'banned')
  ),
  constraint keys_banned_requires_timestamp check (status <> 'banned' or banned_at is not null),
  constraint keys_max_activations_check check (max_activations >= 1),
  constraint keys_activation_count_check check (activation_count >= 0)
);
create index if not exists keys_user_id_idx on keys (user_id);
create index if not exists keys_owner_discord_id_idx on keys (owner_discord_id);
create index if not exists keys_status_idx on keys (status);
create index if not exists keys_bound_hwid_hash_idx on keys (bound_hwid_hash);
create index if not exists keys_banned_partial_idx on keys (banned_at) where status = 'banned';

create table if not exists script_access_logs (
  id uuid primary key default gen_random_uuid(),
  script_id uuid not null references scripts (id),
  version_id uuid references script_versions (id),
  actor_user_id uuid references users (id),
  key_id uuid references keys (id),
  ip text,
  user_agent text,
  result text not null,
  created_at timestamptz not null default now(),
  constraint script_access_logs_result_check check (result in ('granted', 'denied', 'not_found'))
);
create index if not exists script_access_logs_script_id_idx on script_access_logs (script_id);
create index if not exists script_access_logs_created_at_idx on script_access_logs (created_at);

-- ---------------------------------------------------------------------------
-- Ban and reactivation workflow
-- ---------------------------------------------------------------------------

create table if not exists key_bans (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete restrict,
  reason text not null,
  detected_at timestamptz not null,
  banned_at timestamptz,
  detection_category text not null,
  confidence text not null,
  reviewed_by uuid references users (id),
  review_status text not null default 'pending_review',
  reversed_at timestamptz,
  reversed_by uuid references users (id),
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint key_bans_detection_category_check check (
    detection_category in (
      'multi_device_pattern', 'concurrent_sessions', 'impossible_travel',
      'third_party_report', 'resale_listing', 'owner_admission', 'other'
    )
  ),
  constraint key_bans_confidence_check check (confidence in ('high', 'confirmed')),
  constraint key_bans_review_status_check check (
    review_status in ('pending_review', 'confirmed', 'rejected', 'reversed')
  ),
  constraint key_bans_reversal_fields_check check (
    review_status <> 'reversed'
    or (reversed_at is not null and reversed_by is not null and reversal_reason is not null)
  ),
  constraint key_bans_applied_requires_banned_at check (
    review_status not in ('confirmed', 'reversed') or banned_at is not null
  )
);
create unique index if not exists key_bans_live_unique
  on key_bans (key_id) where review_status in ('pending_review', 'confirmed');
create index if not exists key_bans_key_id_idx on key_bans (key_id);
create index if not exists key_bans_banned_at_idx on key_bans (banned_at);
create index if not exists key_bans_review_status_idx on key_bans (review_status);
create index if not exists key_bans_confidence_idx on key_bans (confidence);

create table if not exists key_ban_evidence (
  id uuid primary key default gen_random_uuid(),
  ban_id uuid not null references key_bans (id) on delete restrict,
  evidence_type text not null,
  source_table text,
  source_id uuid,
  hwid_fingerprint text,
  summary text,
  metadata jsonb,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  constraint key_ban_evidence_type_check check (
    evidence_type in (
      'device_history', 'session_history', 'validation_failure',
      'access_log', 'external_report', 'admin_note'
    )
  ),
  constraint key_ban_evidence_source_pair_check check ((source_table is null) = (source_id is null))
);
create index if not exists key_ban_evidence_ban_id_idx on key_ban_evidence (ban_id);
create index if not exists key_ban_evidence_type_idx on key_ban_evidence (evidence_type);
create index if not exists key_ban_evidence_source_idx on key_ban_evidence (source_table, source_id);

create table if not exists key_ban_reversals (
  id uuid primary key default gen_random_uuid(),
  ban_id uuid not null references key_bans (id) on delete restrict,
  key_id uuid not null references keys (id) on delete restrict,
  requested_by uuid not null references users (id),
  justification text not null,
  status text not null default 'pending_approval',
  decided_by uuid references users (id),
  decided_at timestamptz,
  decision_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint key_ban_reversals_status_check check (
    status in ('pending_approval', 'approved', 'rejected', 'cancelled')
  ),
  constraint key_ban_reversals_lifecycle_check check (
    (status = 'pending_approval'
      and decided_by is null and decided_at is null
      and decision_reason is null and cancelled_at is null)
    or (status in ('approved', 'rejected')
      and decided_by is not null and decided_at is not null
      and decision_reason is not null and cancelled_at is null)
    or (status = 'cancelled'
      and decided_by is null and decided_at is null
      and decision_reason is null and cancelled_at is not null)
  ),
  constraint key_ban_reversals_no_self_approval check (
    decided_by is null or decided_by <> requested_by
  )
);
create unique index if not exists key_ban_reversals_open_unique
  on key_ban_reversals (ban_id) where status = 'pending_approval';
create index if not exists key_ban_reversals_ban_id_idx on key_ban_reversals (ban_id);
create index if not exists key_ban_reversals_key_id_idx on key_ban_reversals (key_id);
create index if not exists key_ban_reversals_requested_by_idx on key_ban_reversals (requested_by);
create index if not exists key_ban_reversals_created_at_idx on key_ban_reversals (created_at);
create index if not exists key_ban_reversals_pending_idx
  on key_ban_reversals (status) where status = 'pending_approval';

create table if not exists key_reactivations (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete restrict,
  ban_id uuid not null references key_bans (id) on delete restrict,
  authorized_by uuid not null references users (id),
  reason text not null,
  authorized_at timestamptz not null default now(),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint key_reactivations_consumed_after_granted check (
    consumed_at is null or consumed_at >= authorized_at
  )
);
create unique index if not exists key_reactivations_unused_unique
  on key_reactivations (key_id) where consumed_at is null;
create index if not exists key_reactivations_key_id_idx on key_reactivations (key_id);
create index if not exists key_reactivations_ban_id_idx on key_reactivations (ban_id);
create index if not exists key_reactivations_authorized_by_idx on key_reactivations (authorized_by);
create index if not exists key_reactivations_authorized_at_idx on key_reactivations (authorized_at);

-- ---------------------------------------------------------------------------
-- Device and key session history
-- ---------------------------------------------------------------------------

create table if not exists key_device_history (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  event text not null,
  hwid_fingerprint text,
  actor_user_id uuid references users (id),
  actor_admin_id uuid references users (id),
  ip text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint key_device_history_event_check check (
    event in ('bound', 'validation_failed', 'reset_self', 'reset_admin', 'revoked', 'banned', 'ban_reversed')
  )
);
create index if not exists key_device_history_key_id_idx on key_device_history (key_id);
create index if not exists key_device_history_created_at_idx on key_device_history (created_at);

create table if not exists key_hwid_resets (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  user_id uuid references users (id),
  performed_by text not null,
  admin_id uuid references users (id),
  previous_hwid_fingerprint text,
  new_hwid_fingerprint text,
  reason text,
  created_at timestamptz not null default now(),
  constraint key_hwid_resets_performed_by_check check (performed_by in ('self', 'admin'))
);
create index if not exists key_hwid_resets_key_id_idx on key_hwid_resets (key_id);
create index if not exists key_hwid_resets_user_id_idx on key_hwid_resets (user_id);
create index if not exists key_hwid_resets_created_at_idx on key_hwid_resets (created_at);

create table if not exists key_sessions (
  id uuid primary key default gen_random_uuid(),
  key_id uuid not null references keys (id) on delete cascade,
  user_id uuid not null references users (id),
  session_token_hash text not null,
  hwid_fingerprint text,
  status text not null default 'active',
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint key_sessions_token_hash_key unique (session_token_hash),
  constraint key_sessions_status_check check (status in ('active', 'superseded', 'expired', 'revoked'))
);
create unique index if not exists key_sessions_one_active_per_key
  on key_sessions (key_id) where status = 'active';
create index if not exists key_sessions_key_id_idx on key_sessions (key_id);
create index if not exists key_sessions_user_id_idx on key_sessions (user_id);
create index if not exists key_sessions_expires_at_idx on key_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Settings, payments, offers, content, audit
-- ---------------------------------------------------------------------------

create table if not exists system_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  value jsonb not null,
  updated_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint system_settings_key_key unique (key)
);

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  transaction_id uuid references transactions (id),
  raw_payload jsonb not null,
  signature_valid boolean not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payment_events_provider_event_key unique (provider, provider_event_id)
);

create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  code text not null,
  reward_plan_id uuid references plans (id),
  reward_key_type text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_provider_code_key unique (provider, code)
);

create table if not exists offer_completions (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references offers (id),
  user_id uuid not null references users (id),
  provider_event_id text not null,
  status text not null default 'pending',
  reward_key_id uuid references keys (id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint offer_completions_provider_event_key unique (provider_event_id),
  constraint offer_completions_status_check check (
    status in ('pending', 'verified', 'rejected', 'rewarded')
  )
);
create index if not exists offer_completions_user_id_idx on offer_completions (user_id);
create index if not exists offer_completions_status_idx on offer_completions (status);

create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists changelogs (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  title text not null,
  body text not null,
  published boolean not null default false,
  published_at timestamptz,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users (id),
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_actor_user_id_idx on audit_logs (actor_user_id);
create index if not exists audit_logs_action_idx on audit_logs (action);
create index if not exists audit_logs_created_at_idx on audit_logs (created_at);

-- ---------------------------------------------------------------------------
-- Account sessions and OAuth state (approved D2, Option A)
-- ---------------------------------------------------------------------------

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null,
  user_agent text,
  ip text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  rotated_at timestamptz,
  absolute_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sessions_token_hash_key unique (token_hash)
);
create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

create table if not exists oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null,
  code_verifier text,
  redirect_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint oauth_states_state_hash_key unique (state_hash)
);
create index if not exists oauth_states_expires_at_idx on oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- Phase 1 support tables (D10, D11) and jobs
-- ---------------------------------------------------------------------------

create table if not exists idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  key_hash text not null,
  request_hash text not null,
  actor_id text,
  status text not null default 'processing',
  response_status integer,
  response_body jsonb,
  one_time_secret_issued boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint idempotency_keys_scope_key_unique unique (scope, key_hash),
  constraint idempotency_keys_status_check check (status in ('processing', 'completed'))
);
create index if not exists idempotency_keys_expires_at_idx on idempotency_keys (expires_at);

create table if not exists rate_limit_counters (
  bucket_key text not null,
  window_start timestamptz not null,
  counter integer not null default 0,
  expires_at timestamptz not null,
  primary key (bucket_key, window_start),
  constraint rate_limit_counters_counter_check check (counter >= 0)
);
create index if not exists rate_limit_counters_expires_at_idx on rate_limit_counters (expires_at);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  payload jsonb,
  status text not null default 'pending',
  run_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_status_check check (status in ('pending', 'running', 'completed', 'failed'))
);
create index if not exists jobs_status_run_at_idx on jobs (status, run_at);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, default deny, no client policy.
-- The server connects with a role that bypasses RLS; the browser never does.
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
