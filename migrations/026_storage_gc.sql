-- Storage garbage collection (src/storage-gc.ts). A chunk is collected once nothing refers to it: no
-- live volume's files or snapshots, and no FileRef an agent holds (chunk_pins). Only chunks a write
-- created since collection began are ever collected: such a write records one in chunk_touches, and a
-- chunk with no row there (stored before, however often written or pinned again) is left alone, as
-- FileRefs from before refer to chunks without pins.
create table chunk_touches (
  tenant text not null,
  hash text not null,
  -- When it was last written or referred to: a collection of it that began before stands down.
  at bigint not null,
  primary key (tenant, hash)
);
create table chunk_pins (
  tenant text not null,
  hash text not null,
  agent text not null,
  primary key (tenant, hash, agent)
);
create index chunk_pins_agent on chunk_pins (agent);
-- Chunks a collection found unreferenced, and when: collected if still unreferenced a grace period later.
create table gc_candidates (
  tenant text not null,
  hash text not null,
  first_seen bigint not null,
  primary key (tenant, hash)
);
-- When each tenant's storage is next collected, and which node is collecting it.
create table storage_gc (
  tenant text primary key,
  next_run bigint not null default 0,
  claimed_until bigint
);
-- A deleted volume whose tree and snapshot maps are gone from Storage.
alter table volumes add column purged_at bigint;
