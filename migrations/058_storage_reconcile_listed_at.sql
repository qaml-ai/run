-- When the last storage reconcile began listing Storage (epoch ms, src/storage-usage.ts `reconcile`): the listing counts
-- every object made before it, so a metering delta recorded before it (one a node could not write meanwhile, cut off
-- the database) is dropped when it is flushed, rather than counted a second time on top of the listing.
alter table billing_jobs add column listed_at bigint;
