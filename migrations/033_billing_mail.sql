-- Current-state cooldown checks and feedback correlation use the recipient's
-- durable deliveries; normal balance-crossing events remain independent.
create index billing_email_recipient_created on billing_email_outbox (recipient, kind, created_at);
alter table billing_email_outbox add column provider_message_id text;
