alter table schedules add column calendar jsonb;
alter table schedules add column email jsonb;
create table schedule_deliveries (
  id text primary key,
  tenant text not null,
  agent text not null,
  schedule text not null,
  email jsonb not null,
  state text not null default 'waiting' check (state in ('waiting','sent','failed')),
  created_at bigint not null,
  next_at bigint not null,
  lease text,
  lease_until bigint,
  attempts integer not null default 0,
  message_id text,
  sent_at bigint,
  error text
);
create index schedule_deliveries_pending on schedule_deliveries(next_at) where state = 'waiting';
create index schedule_deliveries_agent on schedule_deliveries(tenant,agent,created_at);
