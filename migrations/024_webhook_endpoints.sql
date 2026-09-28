-- Webhook endpoints (src/webhooks.ts): each tenant's receivers and the event types each selects.
-- The usage webhook becomes its tenant's `legacy` endpoint, which gets usage in its original body.
create table webhook_endpoints (
  id text primary key,
  tenant text not null,
  url text not null,
  events text[] not null,
  description text,
  legacy boolean not null default false,
  -- The Standard Webhooks signing secret, sealed under AGENT_SECRETS_KEY; a replaced one keeps signing until `previous_until`.
  secret jsonb not null,
  previous jsonb,
  previous_until bigint,
  created_at bigint not null
);
create index webhook_endpoints_tenant on webhook_endpoints (tenant);
create unique index webhook_endpoints_legacy on webhook_endpoints (tenant) where legacy;
insert into webhook_endpoints (id, tenant, url, events, legacy, secret, previous, previous_until, created_at)
  select 'we_' || substr(md5(tenant), 1, 24), tenant, url, '{usage.recorded}', true, secret, previous, previous_until, created_at from usage_webhooks;
-- Each delivery names its endpoint; those written before endpoints (none named) go to the tenant's usage webhook.
-- usage_webhooks stays until no running node reads it, for a rolling deploy.
alter table usage_webhook_outbox add column endpoint text;
create index usage_webhook_outbox_endpoint on usage_webhook_outbox (endpoint);
