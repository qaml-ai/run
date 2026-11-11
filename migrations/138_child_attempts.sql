-- Attempted call ids (docs/design/swarm-workflows.md, "Effect keys"): a delegation call's identity is `callId:attempt`,
-- so a call made again on purpose (a workflow's rerun, an abort then a re-issue) makes a new child. No caller sets an
-- attempt yet: every row is a first attempt, the default (a catalog-only change; older nodes' inserts get it too).
alter table agent_children add column attempt int not null default 1;
alter table agent_children add constraint agent_children_attempt_check check (attempt >= 1) not valid;
