-- MONEY: the poll cursor and event journal make a pulled page durable before settlement.
create table camelfs_usage_cursor (
  k smallint primary key check (k = 0),
  cursor text not null,
  polled_at timestamptz
);

create table camelfs_usage_events (
  event_id text primary key,
  vm text not null,
  body jsonb not null,
  received_at timestamptz not null default now(),
  settled_at timestamptz,
  settle_error text,
  unbillable_reason text
);

create index camelfs_usage_events_unsettled on camelfs_usage_events (settled_at) where settled_at is null;
