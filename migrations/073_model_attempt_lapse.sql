-- A provider call whose end never reached the runtime (its host crashed, or the database was away past the retries)
-- and that no provider record can reconcile is settled after a day at its input as estimated at begin, not left
-- pending forever: what it took is known (`estimated_input_tokens`), whether it ended is known (`finished_at`).
alter table model_attempts add column estimated_input_tokens integer;
alter table model_attempts add column finished_at bigint;
