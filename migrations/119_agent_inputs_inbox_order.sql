-- migrate: concurrently
-- Age breaks ties before id. Keep the pending index in the exact page/cursor order.
create index concurrently if not exists agent_inputs_inbox_order on agent_inputs (tenant, priority_rank, expires_at, created_at, id) where state = 'pending';
