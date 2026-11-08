-- The decision inbox (docs/inbox-and-peers-design.md, feature 1): `agent_inputs` becomes the tenant-wide index a person
-- clears from, so each row carries what an index needs to order and filter it without reading its JSON. `src/inputs.ts`
-- fills these at create and settle; the item's own content stays in `input`.
alter table agent_inputs
  -- urgent, high, normal or low: an approval is high, everything else normal.
  add column priority text not null default 'normal',
  -- What a queue sorts by: priority's text is alphabetical (high, low, normal, urgent), not urgent first. urgent 0, high 1,
  -- normal 2, low 3.
  add column priority_rank smallint not null default 2,
  -- True for every input that exists today (an ask_user question, an approval, a form or a url step): the turn waits.
  -- A non-blocking decision (request_decision) keeps the turn going.
  add column blocking boolean not null default true,
  -- Who the asking agent acts for.
  add column subject text,
  -- Who may see and answer: the audience and the definition's approvers, frozen when the item is made.
  add column responders text[] not null default '{}',
  -- The chain's root, and the chain from it to the agent that asks (which is its last): the root agent's own.
  add column root_agent text,
  add column lineage text[],
  -- The asker's own key for the item: a later request with the same key withdraws this one.
  add column item_key text,
  -- Increases on every change (settle, withdraw), so a mirror row and a stream's frames can compare.
  add column version integer not null default 1,
  add column updated_at timestamptz not null default now();

-- Not valid: `agent_inputs` is live, and its rows are written before this constraint exists. Both hold for every row
-- the runtime wrote, and the writer checks them from now on.
alter table agent_inputs add constraint agent_inputs_priority_check check (priority in ('urgent', 'high', 'normal', 'low')) not valid;
-- The rank is the text's order, so the two can never disagree (they are written together, src/inputs.ts).
alter table agent_inputs add constraint agent_inputs_priority_rank_check
  check (priority_rank = case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 when 'low' then 3 end) not valid;
-- `state` was only a comment until now (migrations/016_agent_inputs.sql). `withdrawn` is an item its asker replaced (a
-- later request with the same item_key) or took back: no one answers it.
alter table agent_inputs add constraint agent_inputs_state_check check (state in ('pending', 'answered', 'declined', 'cancelled', 'expired', 'superseded', 'withdrawn')) not valid;
