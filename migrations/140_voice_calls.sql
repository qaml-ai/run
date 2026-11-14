create table voice_calls (
  id text primary key,
  tenant text not null,
  agent text not null,
  provider text not null check (provider in ('openai', 'elevenlabs')),
  model text not null,
  voice text not null,
  state text not null check (state in ('connecting', 'live', 'ending', 'ended')),
  end_reason text,
  node text,
  provider_call text,
  options jsonb not null,
  hold jsonb,
  turns int not null default 0,
  asks int not null default 0,
  audio_seconds numeric not null default 0,
  cost bigint not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index voice_calls_tenant on voice_calls (tenant, created_at desc, id);
create index voice_calls_open on voice_calls (expires_at) where state <> 'ended';
create index voice_calls_provider_call on voice_calls (provider, provider_call) where provider_call is not null;
