-- End-user credit lots (src/end-user-credits.ts): the part of a person's balance that expires, a lot per grant made with
-- `expiresAt` (a subscription's month of credits) or per part of an existing balance a tenant marked so (POST
-- /v1/end-users/{id}/lots). Credit that never expires is the rest of the balance: no row. Paid spend takes the soonest
-- expiring lot first; at its time a lot's unspent part is posted as an `expiry` (what holds made before it reserved of it
-- stays until they settle). `remaining` is in the balance's units (charged micro-USD).
create table end_user_lots (
  id bigserial primary key,
  tenant text not null,
  end_user text not null,
  -- The grant's ledger key (`entry:<key>`), or the tenant's key for a part of the balance it marked.
  key text not null,
  amount bigint not null,
  remaining bigint not null,
  expires_at bigint not null,
  entry_id bigint,
  created_at bigint not null,
  unique (tenant, key)
);
create index end_user_lots_live on end_user_lots (tenant, end_user, expires_at, id) where remaining > 0;

-- A lot's unspent part, posted as it expires.
alter table end_user_ledger drop constraint end_user_ledger_kind_check;
alter table end_user_ledger add constraint end_user_ledger_kind_check check (kind in ('grant', 'refund', 'adjustment', 'usage', 'spend', 'expiry')) not valid;
