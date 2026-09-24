-- Deleted (revoked) and expired agents are purged by a sweep any node runs
-- (ClientSessions.purge): their logs in Storage, tail rows, schedules, channel
-- bindings and volume watches go, and the row stays as a tombstone (purged_at
-- set, header cut to identity) so the id and idempotency key are never reused.
-- A node claims a batch with FOR UPDATE SKIP LOCKED and purge_claimed_until,
-- so nodes share the work and a node that dies mid-purge is retried.
alter table agents add column purged_at bigint;
alter table agents add column purge_claimed_until timestamptz;
create index agents_purge_revoked on agents (id) where purged_at is null and revoked;
create index agents_purge_expiry on agents (expires_at) where purged_at is null and expires_at is not null;
