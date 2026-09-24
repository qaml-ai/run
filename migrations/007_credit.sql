-- Prepaid credit (src/billing.ts). Amounts are integer micro-USD: 1 USD = 1,000,000.
-- The ledger is append-only; each tenant's balance is the sum of its entries, kept
-- in `credit_accounts` by the same statement that appends them.

-- Tenants created by sign-in from now on pay from prepaid credit. Those that exist
-- already were admitted as members of the operator's organization and stay unbilled.
alter table tenants add column billing text not null default 'none' check (billing in ('prepaid', 'none'));
alter table tenants alter column billing set default 'prepaid';

create table credit_ledger (
  id bigserial primary key,
  tenant text not null,
  kind text not null check (kind in ('grant', 'purchase', 'usage', 'storage', 'adjustment', 'refund')),
  -- Positive adds credit, negative spends it.
  amount bigint not null,
  -- Whatever caused the entry, so a retried flush, job or webhook never posts twice.
  idempotency_key text not null unique,
  metadata jsonb not null default '{}',
  created_at bigint not null
);
create index credit_ledger_tenant on credit_ledger (tenant, id);

create table credit_accounts (
  tenant text primary key,
  balance bigint not null default 0,
  -- Lifetime purchases net of refunds: a tenant that never bought credit is on free credit.
  purchased bigint not null default 0
);

-- Usage flushes already applied, so a flush retried after a lost commit acknowledgement is skipped.
create table usage_flushes (
  id uuid primary key,
  created_at timestamptz not null default now()
);
create index usage_flushes_created on usage_flushes (created_at);

-- Of each day's responses and cost, the part that ran on the platform's provider keys rather than the tenant's own.
alter table usage add column platform_responses bigint not null default 0;
alter table usage add column platform_cost double precision not null default 0;

-- Jobs one node runs at a time, like the daily storage charge: a claim that lapses if its node dies.
create table billing_jobs (
  name text primary key,
  -- The last UTC day the job finished for.
  done_day date,
  claimed_by text,
  claimed_until timestamptz
);
