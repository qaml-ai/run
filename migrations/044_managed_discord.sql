-- The shared application owns installations; an invite does not create a tenant binding.
create table discord_installations (
  application_id text not null,
  guild_id text not null,
  name text not null default '',
  state text not null check (state in ('present', 'unavailable', 'removed')),
  updated_at bigint not null,
  primary key (application_id, guild_id)
);
create table discord_server_bindings (
  id text primary key,
  application_id text not null,
  guild_id text not null,
  tenant text not null,
  channel_id text unique references channels(id) on delete set null,
  state text not null check (state in ('active', 'paused', 'disconnected')),
  allowed_channel_ids jsonb not null default '[]',
  administrator_id text not null,
  created_at bigint not null,
  updated_at bigint not null,
  unique (application_id, guild_id),
  foreign key (application_id, guild_id) references discord_installations(application_id, guild_id)
);
create index discord_bindings_tenant on discord_server_bindings (tenant);
-- OAuth state and bearer grants are short lived and bound to a specific console session.
create table discord_setup_attempts (
  state_hash text primary key,
  tenant text not null,
  session_hash text not null,
  guild_id text,
  expires_at bigint not null
);
create table discord_account_links (
  tenant text not null,
  session_hash text not null,
  discord_user_id text not null,
  token text not null,
  expires_at bigint not null,
  primary key (tenant, session_hash)
);
-- Shared cooldowns survive Gateway takeover and bound zero-inference setup traffic.
create table discord_setup_cooldowns (
  key text primary key,
  until_at bigint not null,
  count integer not null default 1
);
