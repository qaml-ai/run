-- Owner model, expand step (docs/design/swarm-workflows.md, "Children and exactly-once"). Delegated work belongs to an
-- owner `{ kind, id }` (an agent today, a workflow next), not to an agent id. This migration only adds: every old
-- column keeps being written, and no key or constraint an `on conflict` relies on changes. The contract deploy
-- (PR 6) moves readers over and drops `agent_children.parent`'s role and `agent_inputs.agent`.
--
-- agent_children (Node): who owns the child run, the root owner of its chain and the chain itself (owners above the
-- child, the root first, its owner last), stored when the row is written. A row an older node writes has no owner_id;
-- its owner is `parent`, and its root `root`. owner_kind's default is a catalog-only change (no table rewrite).
alter table agent_children add column owner_kind text not null default 'agent';
alter table agent_children add column owner_id text;
alter table agent_children add column root_owner jsonb;
alter table agent_children add column chain jsonb;
-- Not valid, as 116 does: the table is live and every row it has holds the default; the writers check it from now on.
alter table agent_children add constraint agent_children_owner_kind_check check (owner_kind in ('agent', 'workflow')) not valid;

-- agent_inputs: an input's owner (a gate of a workflow has no agent). Backfilled from `agent`; a row an older node
-- writes during the rollout has no owner_id until the contract deploy backfills again, so readers take
-- coalesce(owner_id, agent) until then.
alter table agent_inputs add column owner_kind text not null default 'agent';
alter table agent_inputs add column owner_id text;
alter table agent_inputs add constraint agent_inputs_owner_kind_check check (owner_kind in ('agent', 'workflow')) not valid;
update agent_inputs set owner_id = agent where owner_id is null;
