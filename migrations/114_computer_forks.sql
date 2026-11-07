-- Forked computers: one snapshot per parent connection and call (batch), shared by every child of that call, and
-- dropped once no connection starts from it. `reference` is sealed: the provider's snapshot and what deletes it.
create table computer_snapshots (
  id text primary key,
  tenant text not null,
  connection text not null,
  agent text not null,
  batch text not null,
  provider text not null,
  reference text not null,
  created_at bigint not null,
  dropped_at bigint,
  error text
);
create unique index computer_snapshots_batch on computer_snapshots (connection, batch) where dropped_at is null;
create index computer_snapshots_open on computer_snapshots (created_at) where dropped_at is null;
create index computer_snapshots_tenant on computer_snapshots (tenant);
-- A forked connection's sessions start from its seed; forked_from says where it came from.
alter table computer_connections add column seed text, add column forked_from jsonb;
create index computer_connections_seed on computer_connections (seed) where seed is not null;
