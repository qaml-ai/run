-- Revisit captured OpenRouter generations now that tenant-owned keys are supported.
-- No charges or final states change here; the worker still requires provider evidence.
update model_attempts set next_check_at=0
where provider='openrouter' and generation_id is not null and state<>'settled';
