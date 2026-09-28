-- Which events a tenant's webhook receives (src/usage-webhooks.ts): per-response usage, as
-- before, and agents' lifecycle (run.started, run.finished, input.requested, input.resolved).
alter table usage_webhooks add column events text[] not null default '{usage}';
