-- Trace export (src/telemetry.ts): each tenant's OTLP/HTTP endpoint for its agents' spans. Headers (a collector's
-- API key) are sealed under AGENT_SECRETS_KEY and kept only for the origin they were given for; the API shows their
-- names. The last export and failure are what GET /v1/telemetry reports.
create table telemetry_exporters (
  tenant text primary key,
  endpoint text not null,
  origin text not null,
  protocol text not null,
  sample_rate double precision not null default 1,
  include_content boolean not null default false,
  headers jsonb,
  header_names text[] not null default '{}',
  created_at bigint not null,
  updated_at bigint not null,
  last_export_at bigint,
  last_error text,
  last_error_at bigint
);
