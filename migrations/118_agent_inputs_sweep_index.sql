-- migrate: concurrently
-- The Workers inbox sweep reads the oldest pending rows without sorting the full inbox.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_inputs_pending_updated_at
  ON agent_inputs (updated_at) WHERE state = 'pending';
