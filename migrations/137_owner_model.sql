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

-- agent_inputs: an input's owner (a gate of a workflow has no agent). Not backfilled here: an update of every row in
-- this transaction would hold the add column's ACCESS EXCLUSIVE lock for the whole rewrite, and the table is too busy for
-- that (117-119). Rows written before this (and by older nodes during the rollout) have no owner_id, so readers take
-- coalesce(owner_id, agent); the contract deploy backfills in batches, outside a transaction, before dropping `agent`.
alter table agent_inputs add column owner_kind text not null default 'agent';
alter table agent_inputs add column owner_id text;
alter table agent_inputs add constraint agent_inputs_owner_kind_check check (owner_kind in ('agent', 'workflow')) not valid;
