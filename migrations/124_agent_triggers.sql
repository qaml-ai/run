create table agent_triggers (
 id uuid primary key, agent text not null references agents(id) on delete cascade,
 tenant text not null, token_hash text not null unique, config jsonb not null, sealed jsonb
);
create table trigger_deliveries (
 id uuid primary key, trigger_id uuid not null references agent_triggers(id) on delete cascade,
 delivery_key text, status text not null, verified boolean not null, deduped boolean not null,
 run_id text, run_agent text, error text, created_at bigint not null, claimed_until bigint, data jsonb
);
create index trigger_deliveries_trigger_time on trigger_deliveries(trigger_id,created_at);
create index trigger_deliveries_queue on trigger_deliveries(claimed_until) where status='queued';
create index trigger_deliveries_dedupe on trigger_deliveries(trigger_id,delivery_key,created_at) where verified and not deduped;
