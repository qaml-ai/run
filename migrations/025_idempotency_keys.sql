-- Idempotency-Key headers on POST requests (src/idempotency.ts): each tenant's keys, what they were
-- sent with, and the first success they answered, kept for a day.
create table idempotency_keys (
  tenant text not null,
  key text not null,
  -- The method, path and body the key was first sent with: another request with the key is refused.
  fingerprint text not null,
  -- Null while the first request runs.
  status integer,
  body text,
  content_type text,
  created_at bigint not null,
  primary key (tenant, key)
);
create index idempotency_keys_created on idempotency_keys (created_at);
