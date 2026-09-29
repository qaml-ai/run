-- OAuth for the hosted MCP endpoint (src/oauth.ts). Clients register without a row (their client_id is signed);
-- a grant is a person's consent that one client act for their tenant, and its tokens act as the tenant, like an
-- API token, until they expire or the grant is revoked.
create table oauth_grants (
  id text primary key,
  tenant text not null,
  client_id text not null,
  client_name text not null,
  -- The GitHub login that consented, when the console session had one.
  login text,
  scope text not null,
  created_at bigint not null,
  used_at bigint
);
create index oauth_grants_tenant on oauth_grants (tenant);

-- Authorization codes, access tokens and refresh tokens, by their SHA-256. A code has no grant yet (the grant is
-- made when it is exchanged) and carries the consent in `data`. A refresh token is kept after use (`used_at`), so
-- presenting it again is seen as theft and revokes its grant.
create table oauth_tokens (
  sha256 text primary key,
  kind text not null check (kind in ('code', 'access', 'refresh')),
  grant_id text references oauth_grants (id) on delete cascade,
  expires_at bigint not null,
  used_at bigint,
  data jsonb
);
create index oauth_tokens_grant on oauth_tokens (grant_id);
create index oauth_tokens_expires on oauth_tokens (expires_at);
