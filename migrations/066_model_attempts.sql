-- Durable identity of each provider call, independent of agent/transcript retention.
-- No prompts, completions or credentials. Unknown outcomes remain pending, never assumed free.
create table model_attempts (
  id uuid primary key,
  tenant text not null,
  agent text not null,
  provider text not null,
  model text not null,
  kind text not null check (kind in ('response', 'compaction')),
  platform boolean not null,
  catalog_priced boolean not null,
  prepaid boolean not null,
  key_hash text,
  context jsonb not null default '{}',
  generation_id text,
  state text not null default 'pending' check (state in ('pending','estimated','settled')),
  started_at bigint not null,
  updated_at bigint not null,
  next_check_at bigint not null,
  checks integer not null default 0,
  revision integer not null default 0,
  totals jsonb,
  charge bigint not null default 0,
  last_error text
);
create index model_attempts_tenant on model_attempts (tenant, id);
create index model_attempts_pending on model_attempts (next_check_at) where state <> 'settled';
create unique index model_attempts_generation on model_attempts (provider, key_hash, generation_id) where generation_id is not null;
