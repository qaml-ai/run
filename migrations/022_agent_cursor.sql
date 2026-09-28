-- An agent's event cursor where its last owner stopped (src/client-sessions.ts): `cursor_clean` says
-- no event was published after `last_cursor`, so the next owner goes on from it and a subscriber
-- holding it resumes without a gap. A load clears it at once, so a crash never reuses an id.
alter table agents add column last_cursor bigint;
alter table agents add column cursor_clean boolean not null default false;
-- How many messages an agent's runs had reported when it last unloaded (src/history-pages.ts): a page of
-- it read without loading it compares its index with this, as a loaded one does with its requests.
alter table agent_history_index add column reported integer not null default 0;
-- Runs an agent's last owner left queued (a drain hands them to the next owner): a node's sweep
-- loads an agent no node holds that has them, or whose owner died, so they run.
alter table agents add column pending_runs boolean not null default false;
create index agents_pending_runs on agents (id) where pending_runs;
