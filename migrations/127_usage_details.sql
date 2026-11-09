-- One migration for the unreleased attribution schema and its daily aggregates.
-- Attribution is retained with accounting, independently of agent retention.
create table if not exists usage_details (
  tenant text not null, agent text, root_agent text, definition text, end_user text, workspace text,
  occurred_at bigint not null, day date not null, model text not null, totals jsonb not null
);
-- Replace per-call details with one aggregate per attribution tuple, including null dimensions.
-- Keep attribution on existing model attempts before removing their per-call lookup data.
update model_attempts m set context = coalesce(m.context, '{}'::jsonb) || jsonb_build_object('usageAttribution',
  jsonb_build_object('root', d.root_agent, 'definition', d.definition, 'workspace', d.workspace))
from (select distinct on (tenant,agent,occurred_at) tenant,agent,occurred_at,root_agent,definition,workspace
  from usage_details order by tenant,agent,occurred_at) d
where m.tenant=d.tenant and m.agent=d.agent and m.started_at=d.occurred_at;

create table usage_details_daily (
  tenant text not null, day date not null, agent text, root_agent text, definition text,
  end_user text, model text not null, workspace text, totals jsonb not null,
  unique nulls not distinct (tenant,day,agent,root_agent,definition,end_user,model,workspace)
);
insert into usage_details_daily
select tenant,day,agent,root_agent,definition,end_user,model,workspace,jsonb_build_object(
'responses', sum(coalesce((totals->>'responses')::double precision,0)),
'input', sum(coalesce((totals->>'input')::double precision,0)),
'output', sum(coalesce((totals->>'output')::double precision,0)),
'cacheRead', sum(coalesce((totals->>'cacheRead')::double precision,0)),
'cacheWrite', sum(coalesce((totals->>'cacheWrite')::double precision,0)),
'cost', sum(coalesce((totals->>'cost')::double precision,0)),
'platformResponses', sum(coalesce((totals->>'platformResponses')::double precision,0)),
'platformCost', sum(coalesce((totals->>'platformCost')::double precision,0)))
from usage_details where day >= (now() at time zone 'UTC')::date - 399
group by tenant,day,agent,root_agent,definition,end_user,model,workspace;
drop table usage_details;
alter table usage_details_daily rename to usage_details;
create index usage_details_tenant_day on usage_details (tenant,day);
create index usage_details_agent_day on usage_details (tenant,agent,day);
create index usage_details_root_day on usage_details (tenant,root_agent,day);
create index usage_details_workspace_day on usage_details (tenant,workspace,day);
create index usage_details_retention on usage_details (day);
