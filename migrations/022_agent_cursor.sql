-- An agent's event cursor where its last owner stopped (src/client-sessions.ts): `cursor_clean` says
-- no event was published after `last_cursor`, so the next owner goes on from it and a subscriber
-- holding it resumes without a gap. A load clears it at once, so a crash never reuses an id.
alter table agents add column last_cursor bigint;
alter table agents add column cursor_clean boolean not null default false;
-- How many messages an agent's runs had reported when it last unloaded (src/history-pages.ts): a page of
-- it read without loading it compares its index with this, as a loaded one does with its requests.
alter table agent_history_index add column reported integer not null default 0;
-- Whether an agent has runs open: set as the first of a busy spell opens, cleared by an unload with
-- none. A node's sweep loads an agent so marked that no live node holds (its owner died, or a drain
-- left runs queued), so they run.
alter table agents add column pending_runs boolean not null default false;
create index agents_pending_runs on agents (id) where pending_runs;
-- Loads of an agent with work left that failed (src/client-sessions.ts `deferResume`): the next is
-- tried no sooner than `resume_after` (ms), backing off to at most an hour, never for good. A node
-- that gives the agent back for want of room also sets `resume_after`, one interval out.
alter table agents add column resume_failures integer not null default 0;
alter table agents add column resume_after bigint;
