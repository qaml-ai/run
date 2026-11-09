alter table schedule_runs add column state text not null default 'unknown';
alter table schedule_runs add column cost double precision not null default 0;
alter table schedule_runs add column ended_at bigint;
alter table schedule_runs add column expires_at bigint;
update schedule_runs set state='failed' where error is not null;
update schedule_runs set expires_at=created_at+604800000 where run_agent is distinct from agent and run_agent is not null;
create index schedule_runs_retention on schedule_runs(created_at,id);
create index schedule_runs_fresh on schedule_runs(tenant,schedule,expires_at) where expires_at is not null;
