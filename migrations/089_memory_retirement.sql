-- A memory retirement holds the cluster guard for the life of its heartbeat.
alter table runtime_nodes add column memory_retiring boolean not null default false;
alter table runtime_nodes add column memory_high boolean not null default false;

-- Keep the cooldown after the retiring node has left or its heartbeat has expired.
create table memory_retirement_guard (
  singleton boolean primary key default true check (singleton),
  last_claim_at timestamptz
);
insert into memory_retirement_guard (singleton) values (true);
