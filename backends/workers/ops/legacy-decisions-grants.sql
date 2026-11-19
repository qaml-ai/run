-- Use a dedicated login role and an uncached Hyperdrive binding to the legacy database.
-- Execute with psql -v decision_role=<role>. Use a separate role from the shared compatibility role.
grant usage on schema public to :"decision_role";
grant select (id, billing, limits) on tenants to :"decision_role";
grant select (tenant) on account_deletions to :"decision_role";
grant select (tenant, id, sha256) on api_tokens to :"decision_role";
grant select (tenant, login, name, method, sha256, expires_at) on console_sessions to :"decision_role";
grant select (grant_id, expires_at, sha256, kind) on oauth_tokens to :"decision_role";
grant select (id, tenant, login, resource) on oauth_grants to :"decision_role";
grant select (tenant, provider, sealed, region) on provider_keys to :"decision_role";
grant select (tenant, scope, provider, sealed, settings) on key_scope_providers to :"decision_role";

grant select (tenant, id, header) on agents to :"decision_role";
grant select (tenant, child, request_id, root) on agent_children to :"decision_role";
grant select (tenant, kind, resource, assigned_at, sequence, workspace) on workspace_assignments to :"decision_role";
grant select (tenant, closed) on billing_disputes to :"decision_role";
grant select on end_user_settings to :"decision_role";
grant select on end_user_lots to :"decision_role";
grant update (remaining) on end_user_lots to :"decision_role";

grant select, insert on end_user_ledger, usage_flushes to :"decision_role";
grant select, insert on end_users to :"decision_role";
grant update (balance, updated_at, low_notified, low_rearmed, depleted_notified, depleted_rearmed) on end_users to :"decision_role";
grant select, insert, update on end_user_days, rate_limits to :"decision_role";
grant select, insert, update on usage, usage_details, usage_bucket_details, workspace_usage to :"decision_role";
grant select, insert on credit_accounts, credit_ledger, credit_spend_minutes to :"decision_role";
grant update (balance) on credit_accounts to :"decision_role";
grant update (amount, metadata) on credit_ledger to :"decision_role";
grant update (amount) on credit_spend_minutes to :"decision_role";
grant usage on sequence end_user_ledger_id_seq, credit_ledger_id_seq to :"decision_role";

grant select (id, tenant, events) on webhook_endpoints to :"decision_role";
grant select (id), insert on webhook_deliveries to :"decision_role";

-- The existing credit_accounts trigger emits these notices in the debit transaction.
grant select (tenant, threshold) on billing_alert_settings to :"decision_role";
grant select (tenant, id, status, low, depleted, problems, receipts) on billing_recipients to :"decision_role";
grant select (id), insert on billing_events to :"decision_role";
grant insert on billing_email_outbox to :"decision_role";
