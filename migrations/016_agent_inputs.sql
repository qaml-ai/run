-- Human input: a question, an approval or a setup step a suspended turn waits on (src/inputs.ts).
-- One run's inputs are a suspension; the turn resumes once the last of them settles.
create table agent_inputs (
  id text primary key,
  agent text not null,
  tenant text not null,
  -- The run that suspended, and the open tool call the input answers.
  request_id text not null,
  tool_call_id text not null,
  kind text not null,
  -- pending, answered, declined, cancelled, expired or superseded.
  state text not null default 'pending',
  -- What the human is shown, who may answer, and (for a tool's own request) how the call is retried.
  input jsonb not null,
  answer jsonb,
  created_at bigint not null,
  expires_at bigint not null,
  claimed_until timestamptz
);
create index agent_inputs_agent on agent_inputs (agent, request_id);
create index agent_inputs_pending on agent_inputs (tenant, created_at) where state = 'pending';
create index agent_inputs_due on agent_inputs (expires_at) where state = 'pending';
