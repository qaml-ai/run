-- Known-bucket subsets complement usage_details without changing its conflict key.
-- Older servers can keep writing the original totals during rolling deployments.
create table usage_bucket_details (
  tenant text not null, day date not null, agent text, root_agent text, definition text,
  end_user text, model text not null, workspace text, bucket text not null, totals jsonb not null,
  unique nulls not distinct (tenant, day, agent, root_agent, definition, end_user, model, workspace, bucket)
);
create index usage_bucket_details_tenant_day on usage_bucket_details (tenant, day);
create index usage_bucket_details_agent_day on usage_bucket_details (tenant, agent, day);
create index usage_bucket_details_root_day on usage_bucket_details (tenant, root_agent, day);
create index usage_bucket_details_workspace_day on usage_bucket_details (tenant, workspace, day);
create index usage_bucket_details_retention on usage_bucket_details (day);
