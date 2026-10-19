-- migrate: concurrently
-- End-user credits: a person's ledger without its usage (grants, refunds and adjustments: their credit history, and
-- each day's entries in GET /v1/end-users/{id}/days), read from their few other entries however much usage they have.
-- Built concurrently: end_user_ledger takes a row for every metered call, and a plain build would hold its writes.
create index concurrently if not exists end_user_ledger_entries on end_user_ledger (tenant, end_user, id) where kind <> 'usage';
