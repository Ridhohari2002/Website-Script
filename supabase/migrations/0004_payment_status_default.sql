-- Payment status must fail closed for any future checkout flow.
--
-- Earlier migrations created `key_purchases.payment_status` with a `paid`
-- default. A checkout that inserts a purchase before server-side payment
-- verification would therefore look paid even though no payment exists. New
-- records now default to `pending`; only an explicit server-verified write may
-- set `paid`.
--
-- Existing rows are intentionally not updated. The legacy backfill in
-- 0002_executor_first.sql still writes the explicit `legacy` value.

alter table key_purchases
  alter column payment_status set default 'pending';

comment on column key_purchases.payment_status is
  'pending by default; paid only after server-side verification; legacy rows use an explicit legacy value';
