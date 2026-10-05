-- Who last set where each of a tenant's webhooks and its trace export send its data: "token:<API token id>",
-- "oauth:<grant id>", "console" or "operator" (null: set before this was recorded). Revoking a token or grant lists
-- the ones it set, which keep sending until the tenant changes or deletes them.
alter table webhook_endpoints add column set_by text;
alter table usage_webhooks add column set_by text;
alter table telemetry_exporters add column set_by text;
