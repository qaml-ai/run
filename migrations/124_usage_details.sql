-- Attribution is retained with accounting, independently of agent retention.
create table usage_details (
  tenant text not null, agent text, root_agent text, definition text, end_user text, workspace text,
  occurred_at bigint not null, day date not null, model text not null, totals jsonb not null
);
create index usage_details_tenant_day on usage_details (tenant, day);
create index usage_details_agent_day on usage_details (tenant, agent, day);
create index usage_details_root_day on usage_details (tenant, root_agent, day);
create index usage_details_call on usage_details (tenant, agent, occurred_at, model);
