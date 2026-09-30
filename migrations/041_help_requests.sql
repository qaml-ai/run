-- Get Help submissions (src/help.ts). One row per console submission id, so a retry sends only
-- the email not yet accepted. Addresses and sources are kept as keyed hashes, for rate limits only.
-- The snapshot freezes the server-side context a retry sends again; it is cleared once delivered.
create table help_requests (
  id uuid primary key,
  tenant text not null,
  reference text not null,
  payload_sha256 text not null,
  email_hash text not null,
  source_hash text,
  snapshot jsonb,
  status text not null check (status in ('pending', 'failed', 'delivered')),
  lease uuid,
  leased_until timestamptz,
  internal_accepted_at bigint,
  internal_message_id text,
  thread_accepted_at bigint,
  thread_message_id text,
  created_at bigint not null,
  updated_at bigint not null
);
create index help_requests_tenant on help_requests (tenant, created_at);
create index help_requests_email on help_requests (email_hash, created_at);
create index help_requests_source on help_requests (source_hash, created_at) where source_hash is not null;
