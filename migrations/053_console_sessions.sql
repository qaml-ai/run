-- Console sessions, server-side: the cookie carries a random id and this row (keyed by its hash) is the session,
-- so signing out ends it here, and "sign out everywhere" ends all of a tenant's. A session made by signing in
-- with an API token names that token and goes with it when it is revoked; one made with an operator token keeps
-- the token's hash, and ends when the tenants file no longer gives the tenant that token.
create table console_sessions (
  sha256 text primary key,
  tenant text not null,
  login text,
  name text,
  method text not null check (method in ('github', 'google', 'token')),
  token_id uuid references api_tokens (id) on delete cascade,
  operator_sha256 text,
  created_at bigint not null,
  expires_at bigint not null,
  check ((method = 'token') = (token_id is not null or operator_sha256 is not null))
);
create index console_sessions_tenant on console_sessions (tenant);
create index console_sessions_token on console_sessions (token_id) where token_id is not null;
create index console_sessions_expires on console_sessions (expires_at);
