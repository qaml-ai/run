-- Apply to the existing legacy compatibility role with psql -v compatibility_role=<role>.
grant select on end_users, end_user_settings, end_user_lots, end_user_days, end_user_ledger to :"compatibility_role";

-- Full legacy end-user and settings routes plus unmigrated v1 history/input reads.
grant insert, update on end_users, end_user_settings, end_user_lots, end_user_days to :"compatibility_role";
grant insert on end_user_ledger to :"compatibility_role";
grant usage on sequence end_user_ledger_id_seq to :"compatibility_role";
grant select (id, tenant, events) on webhook_endpoints to :"compatibility_role";
grant select (id), insert (id, tenant, endpoint, body, due, created_at) on webhook_deliveries to :"compatibility_role";
grant select on agent_inputs, pi_durable_metadata, pi_durable_entries to :"compatibility_role";
