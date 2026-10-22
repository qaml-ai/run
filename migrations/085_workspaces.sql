create table workspaces (
  id text primary key,
  tenant text not null,
  name text not null,
  archived boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  unique (tenant, id)
);
create index workspaces_tenant on workspaces (tenant, created_at);

-- Keep assignment history: a later move must not move earlier spend or its reconciliation.
create table workspace_assignments (
  sequence bigserial primary key,
  tenant text not null,
  kind text not null check (kind in ('agent', 'definition')),
  resource text not null,
  workspace text,
  assigned_at bigint not null,
  foreign key (tenant, workspace) references workspaces (tenant, id)
);
create index workspace_assignments_resource on workspace_assignments (tenant, kind, resource, assigned_at desc, sequence desc);

create table workspace_usage (
  tenant text not null,
  workspace text not null,
  day date not null,
  model text not null,
  responses bigint not null default 0,
  input bigint not null default 0,
  output bigint not null default 0,
  cache_read bigint not null default 0,
  cache_write bigint not null default 0,
  cost double precision not null default 0,
  platform_responses bigint not null default 0,
  platform_cost double precision not null default 0,
  primary key (tenant, workspace, day, model),
  foreign key (tenant, workspace) references workspaces (tenant, id)
);
