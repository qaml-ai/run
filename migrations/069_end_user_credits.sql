-- End-user credits (src/end-user-credits.ts): a tenant's own users (an agent's or call's `subject`) as billing subjects,
-- each with a paid balance, daily free allowances by bucket, and a daily credit limit. Amounts are integer micro-USD.
-- Allowances count raw cost (what a call costs the tenant); the balance and the daily limit count charged amounts
-- (raw cost with the tenant's markup).

-- A tenant's settings. No row, or `enabled` false: its users are not metered.
create table end_user_settings (
  tenant text primary key,
  enabled boolean not null default false,
  -- Per UTC day, by bucket: {"builder": 50000000, "bot:*": 1000000, "*": 0}.
  allowances jsonb not null default '{}',
  -- The most each user's paid spend may be per UTC day; null: no limit.
  daily_limit bigint,
  -- Added to the raw cost of paid spend, in basis points (2500: +25%).
  markup_bps integer not null default 0,
  -- end_user.balance.low fires when a balance falls below this; null: never.
  low_balance bigint,
  updated_at bigint not null
);

-- Each user's balance and own overrides. Every change to a user's money locks this row first.
create table end_users (
  tenant text not null,
  id text not null,
  balance bigint not null default 0,
  -- Overrides of the tenant's allowances, key by key.
  allowances jsonb not null default '{}',
  daily_limit bigint,
  -- Whether end_user.balance.low and end_user.credit.exhausted (balance) were sent since the balance last rose past them.
  low_notified boolean not null default false,
  depleted_notified boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (tenant, id)
);

-- Every movement of a user's money, appended once under its idempotency key.
create table end_user_ledger (
  id bigserial primary key,
  tenant text not null,
  end_user text not null,
  kind text not null check (kind in ('grant', 'refund', 'adjustment', 'usage')),
  -- What moved the balance: positive adds credit, negative spends it.
  amount bigint not null,
  -- For usage: the call's raw cost, and the part of it the bucket's allowance covered.
  raw bigint not null default 0,
  allowance bigint not null default 0,
  bucket text,
  idempotency_key text not null,
  reference text,
  metadata jsonb not null default '{}',
  balance_after bigint not null,
  created_at bigint not null,
  unique (tenant, idempotency_key)
);
create index end_user_ledger_user on end_user_ledger (tenant, end_user, id);

-- What each user spent per UTC day and bucket: from the allowance (raw) and from the balance (charged).
create table end_user_days (
  tenant text not null,
  end_user text not null,
  day date not null,
  bucket text not null,
  allowance_spent bigint not null default 0,
  paid_spent bigint not null default 0,
  primary key (tenant, end_user, day, bucket)
);

-- Amounts held for calls in flight (a model call's id is its attempt's), released when they settle or expire.
create table end_user_holds (
  id uuid primary key,
  tenant text not null,
  end_user text not null,
  bucket text not null,
  day date not null,
  allowance bigint not null,
  paid bigint not null,
  expires_at bigint not null,
  created_at bigint not null
);
create index end_user_holds_user on end_user_holds (tenant, end_user);

-- A model attempt's end user and what it has posted to their ledger so far, so a correction posts only its delta.
alter table model_attempts add column end_user text;
alter table model_attempts add column end_user_bucket text;
alter table model_attempts add column end_user_raw bigint not null default 0;
alter table model_attempts add column end_user_allowance bigint not null default 0;
alter table model_attempts add column end_user_paid bigint not null default 0;
