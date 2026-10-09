-- A pinned snapshot stays until it is unpinned (or deleted with force): publish's pruning passes it by, and it counts
-- against its own cap, not the 100 kept snapshots. Labels are the owner's own string map, e.g. {"release": "v12"}.
alter table volume_snapshots add column pinned boolean not null default false;
alter table volume_snapshots add column labels jsonb not null default '{}';
