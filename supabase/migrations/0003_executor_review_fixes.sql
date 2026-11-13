-- ---------------------------------------------------------------------------
-- Executor-first review fixes.
--
-- Adds an explicit, auditable admin authorization for keys that were already
-- claimed through the Phase 4 Discord flow. Without that authorization, executor
-- activation must never treat a legacy Discord claim as a new first claim merely
-- because its HWID binding is null.
--
-- Additive only: no existing row, column, or claim metadata is removed.
-- ---------------------------------------------------------------------------

alter table keys
  add column if not exists executor_claim_authorized_at timestamptz;
alter table keys
  add column if not exists executor_claim_authorized_by uuid references users (id);
alter table keys
  add column if not exists executor_claim_authorization_reason text;

create index if not exists keys_executor_claim_authorized_at_idx
  on keys (executor_claim_authorized_at);

-- Legacy detection is conservative. A key that shows any evidence of a prior
-- claim is classified as Discord-claimed, even when the owner column was cleared
-- administratively. Only keys with no claim evidence remain eligible for the
-- executor first-claim path.
update keys
set
  claimed_at = coalesce(claimed_at, hwid_bound_at, created_at),
  claim_kind = 'discord'
where
  claim_kind is null
  and (
    owner_discord_id is not null
    or activation_count > 0
    or bound_hwid_hash is not null
  );
