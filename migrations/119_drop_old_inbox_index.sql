-- 118 replaces 117's inbox index with the full order, including created_at.
-- Run outside the concurrent-index builder, which permits only index creation.
drop index if exists agent_inputs_inbox;
