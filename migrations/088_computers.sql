create table computer_connections (
  id text primary key,
  tenant text not null,
  agent text not null,
  provider text not null,
  credentials jsonb not null,
  lease_seconds integer not null check (lease_seconds between 60 and 900),
  daily_seconds integer not null check (daily_seconds between 60 and 86400),
  created_at bigint not null,
  unique (tenant, agent)
);
create table computer_leases (
  sequence bigserial unique,
  id text primary key,
  tenant text not null,
  agent text not null,
  connection text not null references computer_connections(id),
  workspace text,
  provider text not null,
  state text not null check (state in ('starting','active','closing','closed','uncertain')),
  reference jsonb,
  created_at bigint not null,
  expires_at bigint not null,
  closed_at bigint,
  cleanup_at bigint not null default 0,
  error text
);
create index computer_leases_expiry on computer_leases (expires_at) where state <> 'closed';
create index computer_leases_agent on computer_leases (tenant, agent, created_at desc);
create table computer_commands (
  tenant text not null,
  lease text not null references computer_leases(id),
  key text not null,
  input_hash text not null,
  state text not null check (state in ('pending','completed','uncertain')),
  result jsonb,
  created_at bigint not null,
  primary key (lease, key)
);
create table computer_operations (
  tenant text not null,
  connection text not null references computer_connections(id),
  key text not null,
  input_hash text not null,
  state text not null check (state in ('pending','completed','uncertain')),
  result jsonb,
  primary key (connection,key)
);
