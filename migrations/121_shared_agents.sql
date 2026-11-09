-- A link admits a person; membership, not the link, grants access.
create table agent_share_links (
  id text primary key,
  tenant text not null,
  agent text not null,
  sha256 bytea not null unique,
  created_at bigint not null,
  expires_at bigint,
  revoked_at bigint,
  joins integer not null default 0,
  last_joined_at bigint
);
create index agent_share_links_owner_created on agent_share_links (tenant, agent, created_at);
create table agent_members (
  id text primary key,
  tenant text not null,
  agent text not null,
  person text not null,
  role text not null check (role in ('owner', 'guest')),
  name text not null,
  email text,
  link text,
  added_at bigint not null,
  removed_at bigint,
  daily_cap bigint,
  revision integer not null default 1,
  unique (agent, person)
);
create index agent_members_person on agent_members (person) where removed_at is null;
create table agent_member_days (
  member text not null,
  day date not null,
  charge bigint not null,
  primary key (member, day)
);
