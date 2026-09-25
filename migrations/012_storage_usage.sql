-- What each owner keeps in Storage, tracked as objects are created and deleted
-- (src/storage-usage.ts), so the daily storage charge reads this table rather than
-- listing the bucket. Owners: an agent (kind 'agent', its logs), a volume ('volume',
-- its tree log and snapshot file maps) or a tenant ('tenant', its content-addressed
-- chunks, each counted once). A full listing replaces the rows now and then to correct
-- drift; until the first one, the table is empty and the storage job starts with it.
create table storage_usage (
  kind text not null check (kind in ('agent', 'volume', 'tenant')),
  owner text not null,
  bytes bigint not null default 0,
  primary key (kind, owner)
);
