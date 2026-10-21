-- The Pi migration sweep is gone (#357), and nothing reads its row: an image from before it read the table only through
-- its operator endpoint and with AGENT_PI_SWEEP set, which Terraform no longer sets. Once the host transcript is no
-- longer written, no image from before that can serve a session either (it refuses them: AGENT_NOT_MIGRATED).
drop table if exists pi_sweep;
