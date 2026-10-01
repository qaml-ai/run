-- Fixed-window rate limit counters (src/rate-limits.ts): one row per limited key (a tenant's agent
-- creates or runs, a client's sign-in requests or new accounts), reset when its window turns over.
-- Rows whose window has ended are swept; nothing else reads them.
create table rate_limits (
  key text primary key,
  window_start bigint not null,
  count integer not null,
  expires_at bigint not null
);
create index rate_limits_expires_at on rate_limits (expires_at);
