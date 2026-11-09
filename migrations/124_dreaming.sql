-- Opt-in consolidation. One writer per memory volume; a failed dream retains its window.
create table agent_dreaming (
  agent text primary key references agents(id) on delete cascade,
  tenant text not null,
  volume text not null unique,
  config jsonb not null,
  since bigint not null,
  due_at bigint not null,
  active jsonb,
  last_result jsonb,
  lease_until bigint not null default 0
);
create index agent_dreaming_due on agent_dreaming(due_at);
create table agent_dreaming_runs (
  id text primary key,
  agent text not null references agent_dreaming(agent) on delete cascade,
  tenant text not null,
  created_at bigint not null,
  result jsonb not null
);
create index agent_dreaming_runs_agent on agent_dreaming_runs(agent,created_at);
