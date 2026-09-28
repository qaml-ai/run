-- Webhook endpoints (src/webhooks.ts): each tenant's receivers, the event types each selects, and
-- the outbox of deliveries to them. The usage webhook keeps usage_webhooks and usage_webhook_outbox,
-- which nodes of earlier releases read and send from, so they never see an endpoint's deliveries.
create table webhook_endpoints (
  id text primary key,
  tenant text not null,
  url text not null,
  events text[] not null,
  description text,
  -- The Standard Webhooks signing secret, sealed under AGENT_SECRETS_KEY; a replaced one keeps signing until `previous_until`.
  secret jsonb not null,
  previous jsonb,
  previous_until bigint,
  created_at bigint not null
);
create index webhook_endpoints_tenant on webhook_endpoints (tenant);
create table webhook_deliveries (
  id uuid primary key,
  tenant text not null,
  endpoint text not null,
  body jsonb not null,
  attempts integer not null default 0,
  -- When the next attempt is due; a node sending it holds it by moving this past its attempt.
  due bigint not null,
  created_at bigint not null,
  last_error text
);
create index webhook_deliveries_due on webhook_deliveries (due);
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint);
