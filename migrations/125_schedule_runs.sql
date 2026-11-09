alter table schedules add column cron jsonb;
alter table schedules add column session_mode text not null default 'continue';
alter table schedules add column spend_limit jsonb;
alter table schedules add column mounts jsonb;
create table schedule_runs (
 id text primary key, tenant text not null, agent text not null, schedule text not null,
 run_agent text, created_at bigint not null, error text
);
create index schedule_runs_agent on schedule_runs(tenant,agent,created_at);
insert into schedule_runs(id,tenant,agent,schedule,run_agent,created_at)
 select id,tenant,agent,schedule,agent,created_at from schedule_deliveries;
