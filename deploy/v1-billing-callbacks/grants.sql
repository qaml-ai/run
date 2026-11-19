-- Assign these privileges to a dedicated login role with psql -v callback_role=<role>.
grant usage on schema public to :"callback_role";

grant select (id, billing, limits) on tenants to :"callback_role";
-- Card verification locks the tenant row with FOR UPDATE.
grant update (created_at) on tenants to :"callback_role";
grant select on card_checks, billing_checkout_cutover, billing_checkouts to :"callback_role";
grant insert on card_checks to :"callback_role";
grant update (session, payment_intent, invoice, paid_at, invoice_url) on billing_checkouts to :"callback_role";
grant select, insert on billing_stripe_customers to :"callback_role";
grant update (customer) on billing_stripe_customers to :"callback_role";

grant select, insert on credit_accounts, credit_ledger to :"callback_role";
grant update (balance, purchased, stripe_customer) on credit_accounts to :"callback_role";
grant usage on sequence credit_ledger_id_seq to :"callback_role";
grant select, insert on billing_disputes, billing_stripe_refunds to :"callback_role";
grant update (tenant, status, closed, updated_at) on billing_disputes to :"callback_role";
grant update (refunded, currency, updated_at) on billing_stripe_refunds to :"callback_role";
grant select on billing_auto_settings, billing_auto_attempts to :"callback_role";
grant update (enabled, version) on billing_auto_settings to :"callback_role";
grant update (state, lease, cancel_requested, cancel_reason, due) on billing_auto_attempts to :"callback_role";

grant select (tenant, threshold) on billing_alert_settings to :"callback_role";
grant select (tenant, id, email, status, low, depleted, problems, receipts) on billing_recipients to :"callback_role";
grant update (status) on billing_recipients to :"callback_role";
grant select (id, recipient, state), insert on billing_email_outbox to :"callback_role";
grant update (state, secret) on billing_email_outbox to :"callback_role";
grant insert on billing_email_suppressions to :"callback_role";
grant select (id), insert on billing_events to :"callback_role";
grant select (id, tenant, events) on webhook_endpoints to :"callback_role";
grant insert on webhook_deliveries to :"callback_role";

grant select, insert on journey_accounts to :"callback_role";
grant update (internal, consent, ga_client_id) on journey_accounts to :"callback_role";
grant insert on journey_milestones, journey_outbox to :"callback_role";
grant select (id) on journey_outbox to :"callback_role";
