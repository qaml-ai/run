-- Background sub-agents (spawn_agent, src/client-sessions.ts): one row per child a parent's run started, written before
-- the child's prompt is sent and keyed by the spawn call (`id`), so a resumed turn finds the same child. When the child's
-- run (`request_id`) ends, its notification (`notice`, the parent's prompt params, written once) is submitted to the
-- parent as request `child_<request_id>`, which dedupes; the row is then `notified`. A wait_agent call that answers
-- the ending also makes it `notified`, without the prompt. `claimed_until` keeps other nodes off a delivery in flight;
-- `checked_at` is when a sweep last asked whether the child's run ended. `landed_at`: when the ending reached the
-- parent (its notification's turn began, or a wait answered it), which charges the child's spend once.
create table agent_children (
  id text primary key,
  tenant text not null,
  parent text not null,
  child text not null,
  request_id text not null,
  name text not null,
  depth int not null,
  root text not null,
  parent_run text not null,
  tool_call_id text not null,
  state text not null default 'running' check (state in ('running', 'notified')),
  -- Who took the ending to the parent: its notification ('notice'), or a wait_agent call ('wait').
  landed_by text check (landed_by in ('notice', 'wait')),
  status text,
  notice jsonb,
  ended_at bigint,
  landed_at bigint,
  claimed_until bigint,
  checked_at bigint not null,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index agent_children_request on agent_children (child, request_id);
create index agent_children_parent on agent_children (parent, created_at);
-- A name is the model's handle for a child: unique among its parent's children until they are notified.
create unique index agent_children_running_name on agent_children (parent, name) where state = 'running';
create index agent_children_running on agent_children (checked_at) where state = 'running';

-- Turns that notifications (and, later, agent messages) start, per chain root and hour: past the runtime's cap the
-- input still lands in history, but no turn runs, so two agents cannot wake each other forever.
create table agent_wakes (
  root text not null,
  hour bigint not null,
  turns int not null,
  primary key (root, hour)
);
