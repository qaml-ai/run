-- The team's read-only operations endpoint (/ops/mcp, src/ops-mcp.ts), signed in with the same OAuth server as /mcp.
-- A grant's tokens act on one resource: the hosted endpoint and agents ('agents'), or the operations endpoint ('ops').
-- A token works at its own resource only (src/oauth.ts, authenticate).
alter table oauth_grants add column resource text not null default 'agents' check (resource in ('agents', 'ops'));
