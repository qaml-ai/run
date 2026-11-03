-- migrate: concurrently
-- Usage charts read one user's posting time range. The ledger's (tenant, end_user, id) index cannot bound that range,
-- so a heavy user's full history (or the table) would be scanned. Keep non-usage entries out of this index.
-- Built concurrently: the ledger takes a row per metered call, and a plain build would hold its writes.
create index concurrently if not exists end_user_ledger_usage_time on end_user_ledger (tenant, end_user, created_at) where kind = 'usage';
