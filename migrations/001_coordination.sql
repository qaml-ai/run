-- Control-plane state. Times the API returns (createdAt, dueAt, expiresAt...) are
-- bigint milliseconds from the application; heartbeat and claim deadlines are
-- timestamptz on the database clock, so node clock skew never matters. Documents
-- the runtime hands back as they were given (headers, channels, items) are json,
-- which keeps their key order; jsonb is for values the runtime only reads.

-- Ownership: one heartbeat per node, one row per actor (agent or volume) it serves.
create table runtime_nodes (
  node text primary key,
  session uuid not null,
  expires_at timestamptz not null
);
create table actor_owners (
  actor text primary key,
  -- Null once released; the row stays so the epoch keeps increasing.
  node text,
  session uuid,
  epoch bigint not null
);

-- Accounts. Admin-defined tenants live in the tenants file; this table holds tenants created by console sign-in.
create table tenants (
  id text primary key,
  github text,
  created_at bigint not null
);
create table provider_keys (
  tenant text not null,
  provider text not null,
  -- AES-256-GCM under AGENT_SECRETS_KEY, bound to "<tenant>:<provider>".
  sealed jsonb not null,
  last4 text not null,
  set_at bigint not null,
  primary key (tenant, provider)
);
create table api_tokens (
  sha256 text primary key,
  id uuid not null unique,
  tenant text not null,
  name text not null,
  prefix text not null,
  created_at bigint not null
);
create index api_tokens_tenant on api_tokens (tenant);
create table usage (
  tenant text not null,
  day date not null,
  model text not null,
  responses bigint not null default 0,
  input bigint not null default 0,
  output bigint not null default 0,
  cache_read bigint not null default 0,
  cache_write bigint not null default 0,
  cost double precision not null default 0,
  primary key (tenant, day, model)
);

-- Agents: the session header (identity, configuration, mounts) and what listings need.
-- The request journal and transcript are logs in Storage.
create table agents (
  id text primary key,
  tenant text not null,
  header json not null,
  revision bigint not null,
  name text not null,
  type text not null,
  model text not null,
  expires_at bigint,
  revoked boolean not null default false
);
create index agents_tenant on agents (tenant);

create table schedules (
  id uuid primary key,
  agent text not null,
  tenant text not null,
  text text,
  code text,
  due_at bigint not null,
  every_seconds integer,
  created_at bigint not null,
  claimed_by text,
  claimed_until timestamptz
);
create index schedules_agent on schedules (agent);
create index schedules_due on schedules (due_at);

-- Channels.
create table channels (
  id text primary key,
  tenant text not null,
  channel json not null,
  created_at bigint not null
);
create index channels_tenant on channels (tenant);
create table channel_conversations (
  channel text not null,
  conversation text not null,
  agent text not null,
  generation integer not null,
  primary key (channel, conversation)
);
create table channel_agents (
  agent text primary key,
  channel text not null,
  tenant text not null,
  conversation text not null
);
-- The outbox: an inbound message until its reply is sent, or an outbound message.
create table channel_items (
  id text primary key,
  item json not null,
  due bigint not null,
  claimed_by text,
  claimed_until timestamptz,
  revision bigint not null default 1
);
create index channel_items_due on channel_items (due);
-- Inbound messages already recorded, so provider retries are dropped.
create table channel_seen (
  channel text not null,
  message text not null,
  seen_at timestamptz not null default now(),
  primary key (channel, message)
);
create index channel_seen_at on channel_seen (seen_at);
-- Rate-limit and daily-turn counters, one row per window.
create table channel_counts (
  channel text not null,
  window_key text not null,
  count integer not null,
  created_at timestamptz not null default now(),
  primary key (channel, window_key)
);
create index channel_counts_created on channel_counts (created_at);

-- Volumes. The tree log and chunks (and snapshot file maps) are in Storage.
create table volumes (
  id text primary key,
  tenant text not null,
  name text not null,
  created_at bigint not null,
  origin json,
  deleted_at bigint
);
create index volumes_tenant on volumes (tenant) where deleted_at is null;
create table volume_snapshots (
  id text primary key,
  volume text not null,
  name text not null,
  seq bigint not null,
  created_at bigint not null,
  files integer not null,
  bytes bigint not null
);
create index volume_snapshots_volume on volume_snapshots (volume);
create table volume_watchers (
  volume text not null,
  agent text not null,
  tenant text not null,
  mounts jsonb not null,
  primary key (volume, agent)
);
