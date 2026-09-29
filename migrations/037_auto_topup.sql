create table billing_auto_settings (
  tenant text not null,
  livemode boolean not null,
  enabled boolean not null default false,
  version bigint not null default 0,
  threshold bigint not null default 5000000,
  amount bigint not null default 20000000,
  fee bigint not null default 1100000,
  monthly_limit bigint not null default 200000000,
  status text not null default 'on' check (status in ('on','paused_no_card','limit_reached')),
  consent_at bigint,
  checked_at bigint not null default 0,
  primary key (tenant,livemode)
);
create table billing_auto_quotes (
  id uuid primary key,
  tenant text not null,
  livemode boolean not null,
  threshold bigint not null,
  amount bigint not null,
  fee bigint not null,
  monthly_limit bigint not null,
  created_at bigint not null,
  expires_at bigint not null,
  accepted_at bigint,
  consent_version text,
  consent_card jsonb
);
create index billing_auto_quotes_tenant on billing_auto_quotes (tenant,livemode,created_at desc);
create table billing_auto_attempts (
  id uuid primary key,
  tenant text not null,
  livemode boolean not null,
  settings_version bigint not null,
  period text not null,
  customer text not null,
  amount bigint not null check (amount > 0),
  fee bigint not null check (fee >= 0),
  monthly_limit bigint not null,
  threshold bigint not null,
  card jsonb not null,
  api_version text not null,
  state text not null check (state in ('processing','action_required','paused_declined','paused_no_card','reconcile','paid','cancelled')),
  step text not null check (step in ('create','credit','fee','finalize','prepare','pay','observe')),
  step_started_at bigint,
  submitted_at bigint,
  invoice text unique,
  invoice_url text,
  payment_intent text unique,
  generation integer not null default 0,
  lease uuid,
  lease_until bigint not null default 0,
  due bigint not null,
  created_at bigint not null,
  paid_at bigint
);
create unique index billing_auto_one_active on billing_auto_attempts (tenant,livemode) where state not in ('paid','cancelled');
create index billing_auto_due on billing_auto_attempts (due) where state not in ('paid','cancelled','reconcile');
alter table billing_checkouts add column invoice_url text;

-- Database constraints also protect non-HTTP writers.
alter table billing_auto_settings add check (threshold between 1000000 and 500000000 and threshold % 10000=0),
  add check (amount > 0 and amount % 10000=0), add check (fee >= 0 and fee % 10000=0), add check (monthly_limit >= amount+fee);
alter table billing_auto_quotes add check (threshold between 1000000 and 500000000 and threshold % 10000=0),
  add check (amount > 0 and amount % 10000=0), add check (fee >= 0 and fee % 10000=0), add check (monthly_limit >= amount+fee);
