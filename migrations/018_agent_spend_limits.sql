-- Per-agent spend limits (src/client-sessions.ts): the most an agent may spend on model calls from
-- when the limit was set (`set_at`), and what it has spent since. The agent's owner writes both.
create table agent_spend_limits (
  agent text primary key,
  usd double precision not null,
  spent double precision not null default 0,
  set_at bigint not null
);
