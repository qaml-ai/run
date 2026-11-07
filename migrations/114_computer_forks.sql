-- Forked computers: one snapshot per parent connection and call (batch), shared by every child of that call, and
-- dropped once no connection starts from it. `reference` is sealed: the provider's snapshot and what deletes it.
-- `state` is 'taking' while the call that won the row takes the snapshot (no database connection held), then 'ready'.
-- A drop that fails is tried again from `next_attempt_at`, backing off, and given up (logged) after a bounded count.
create table computer_snapshots (
  id text primary key,
  tenant text not null,
  connection text not null,
  agent text not null,
  batch text not null,
  provider text not null,
  reference text not null,
  state text not null default 'ready',
  created_at bigint not null,
  dropped_at bigint,
  attempts integer not null default 0,
  next_attempt_at bigint not null default 0,
  error text
);
create unique index computer_snapshots_batch on computer_snapshots (connection, batch) where dropped_at is null;
create index computer_snapshots_open on computer_snapshots (next_attempt_at) where dropped_at is null;
create index computer_snapshots_tenant on computer_snapshots (tenant);
-- A forked connection's sessions start from its seed; forked_from says where it came from. A forkable connection's
-- machines are made so they can be snapshotted (Boat's background snapshots): managed ones by default, a tenant's own
-- provider account only when it opts in.
alter table computer_connections add column seed text, add column forked_from jsonb, add column forkable boolean;
create index computer_connections_seed on computer_connections (seed) where seed is not null;
