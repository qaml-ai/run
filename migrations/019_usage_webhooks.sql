-- Usage webhooks (src/usage-webhooks.ts): each tenant's receiver of per-response usage, and the
-- outbox of events not yet delivered. Events are added with the usage flush that counts them.
create table usage_webhooks (
  tenant text primary key,
  url text not null,
  -- The Standard Webhooks signing secret, sealed under AGENT_SECRETS_KEY; a replaced one keeps signing until `previous_until`.
  secret jsonb not null,
  previous jsonb,
  previous_until bigint,
  created_at bigint not null
);
create table usage_webhook_outbox (
  id uuid primary key,
  tenant text not null,
  body jsonb not null,
  attempts integer not null default 0,
  -- When the next attempt is due; a node sending it holds it by moving this past its attempt.
  due bigint not null,
  created_at bigint not null,
  last_error text
);
create index usage_webhook_outbox_due on usage_webhook_outbox (due);
create index usage_webhook_outbox_tenant on usage_webhook_outbox (tenant);
