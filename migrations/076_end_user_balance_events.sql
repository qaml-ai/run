-- End-user balance events (src/end-user-credits.ts): a person's own low-balance threshold over the tenant's (null: the
-- tenant's), and the tenant's allowance warning, a percent of a bucket's daily allowance at which end_user.allowance.low
-- fires (null: never). And whether a grant (or a positive adjustment) since end_user.balance.low or
-- end_user.credit.exhausted (balance) was sent left the balance short of its line: the next debit says it again.
-- Nullable columns, and constant defaults: adding them rewrites no rows.
alter table end_users add column low_balance bigint;
alter table end_users add column low_rearmed boolean not null default false;
alter table end_users add column depleted_rearmed boolean not null default false;
alter table end_user_settings add column allowance_warning_percent integer;
