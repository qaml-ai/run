create table workers_elevenlabs_call_agents (
  key_hash text not null,
  model text not null,
  persona_hash text not null,
  agent_id text not null,
  tool_secret text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  primary key (key_hash, model, persona_hash)
);
create unique index workers_elevenlabs_call_agents_agent on workers_elevenlabs_call_agents (agent_id);

create table workers_elevenlabs_call_webhooks (
  key_hash text primary key,
  webhook_id text not null,
  secret text not null,
  created_at timestamptz not null default now()
);
