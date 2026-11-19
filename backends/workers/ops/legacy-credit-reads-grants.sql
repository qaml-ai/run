-- Apply to the existing legacy compatibility role with psql -v compatibility_role=<role>.
grant select on end_users, end_user_settings, end_user_lots, end_user_days, end_user_ledger to :"compatibility_role";

-- A detail read can settle a due lot using the same transaction as the Node service.
grant insert (tenant, id, created_at, updated_at) on end_users to :"compatibility_role";
grant update (balance, updated_at, low_notified, low_rearmed, depleted_notified, depleted_rearmed) on end_users to :"compatibility_role";
grant update (remaining) on end_user_lots to :"compatibility_role";
grant insert on end_user_ledger to :"compatibility_role";
grant usage on sequence end_user_ledger_id_seq to :"compatibility_role";
grant select (id, tenant, events) on webhook_endpoints to :"compatibility_role";
grant select (id), insert (id, tenant, endpoint, body, due, created_at) on webhook_deliveries to :"compatibility_role";
