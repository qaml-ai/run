-- migrate: concurrently
-- The inbox's page: a tenant's pending items, urgent first, then the soonest auto-answer, then by id. Built concurrently:
-- agent_inputs takes a write for every input an agent asks.
create index concurrently if not exists agent_inputs_inbox on agent_inputs (tenant, priority, expires_at, id) where state = 'pending';
-- `responders` is read as "the items of this actor" (an actor or a channel sender like slack:U0123), which an array
-- needs GIN for.
create index concurrently if not exists agent_inputs_responders on agent_inputs using gin (responders);
