-- migrate: concurrently
-- History reads find entries by ordinal (msg_from). Built concurrently: pi_durable_entries takes every agent's writes.
create index concurrently if not exists pi_entries_history on pi_durable_entries (session_id, msg_from) where msg_from is not null;
