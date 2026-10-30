-- A sub-agent's progress (report_progress, src/client-sessions/children.ts): the latest status it reported on its run's
-- row, latest wins. `progress_seq` counts its reports, so a parent shown one (on its next tool result, as an
-- <agent_updates> block) is not shown it again. A report never starts a turn: an ending supersedes it.
alter table agent_children add column progress text;
alter table agent_children add column progress_seq int not null default 0;
alter table agent_children add column progress_at bigint;
