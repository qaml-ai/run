-- The origins each tenant's browsers may read its agents from with browser tokens (src/cors.ts):
-- a JSON array of `https://host[:port]`, `https://*.host` or `http://localhost[:port]`.
create table tenant_cors_origins (
  tenant text primary key,
  origins jsonb not null,
  updated_at bigint not null
);
