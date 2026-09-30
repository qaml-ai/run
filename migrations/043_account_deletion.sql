-- Account deletion (src/account-deletion.ts): one row per tenant being or having been deleted. The row is the
-- deletion's progress (a node claims it with a lease, and every step is idempotent, so a retry continues), and once
-- complete it keeps the id from ever being given to a new tenant: the ledger rows kept for accounting stay under it.
create table account_deletions (
  tenant text primary key,
  requested_at bigint not null,
  -- "self", or the operator tenant that asked.
  requested_by text not null,
  completed_at bigint,
  claimed_until timestamptz,
  attempts integer not null default 0
);
create index account_deletions_open on account_deletions (requested_at) where completed_at is null;

-- Purged agents' tombstones keep only their id (src/client-sessions.ts `purgeAgent`).
update agents set header = json_build_object('version', 3, 'id', id, 'revoked', true, 'purged', true),
  tenant = '', name = id, type = 'general', model = '', expires_at = null
where purged_at is not null;

-- Email thread metadata nothing deleted before: of deleted channels, and of conversations whose agent was purged (the
-- purge deleted their mapping). A thread only just received has no mapping for a moment, so only day-old ones go.
delete from email_threads t where not exists (select 1 from channels c where c.id = t.channel)
  or (t.updated_at < (extract(epoch from now()) * 1000)::bigint - 86400000
    and not exists (select 1 from channel_conversations cc where cc.channel = t.channel and cc.conversation = t.conversation));
delete from email_messages m where not exists (select 1 from channels c where c.id = m.channel)
  or not exists (select 1 from email_threads t where t.conversation = m.conversation);
