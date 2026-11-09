create table agent_triggers (
 id uuid primary key, agent text not null references agents(id) on delete cascade,
 tenant text not null, token_hash text not null unique, config jsonb not null, sealed jsonb, rejected_count bigint not null default 0, rejected_at bigint
);
create table trigger_deliveries (
 id uuid primary key, trigger_id uuid not null references agent_triggers(id) on delete cascade,
 delivery_key text, status text not null, verified boolean not null, deduped boolean not null,
 run_id text, run_agent text, error text, created_at bigint not null, claimed_until bigint, lease uuid, attempts int not null default 0, next_at bigint not null default 0, data jsonb
);
create index trigger_deliveries_trigger_time on trigger_deliveries(trigger_id,created_at);
create index trigger_deliveries_queue on trigger_deliveries(claimed_until) where status='queued';
create index trigger_deliveries_dedupe on trigger_deliveries(trigger_id,delivery_key,created_at) where status in ('queued','submitted','running','succeeded');

create table trigger_run_agents (
 id uuid primary key references trigger_deliveries(id) on delete cascade,
 trigger_id uuid not null references agent_triggers(id) on delete cascade,
 agent text, expires_at bigint not null
);
create index trigger_run_agents_live on trigger_run_agents(trigger_id,expires_at);
