create table workers_voice_calls (
  id text primary key,
  tenant text not null,
  agent text not null,
  provider text not null check (provider in ('openai', 'elevenlabs')),
  provider_call text,
  state text not null check (state in ('connecting', 'live', 'ending', 'ended')),
  created_at timestamptz not null default now()
);
create index workers_voice_calls_tenant on workers_voice_calls (tenant, created_at desc, id desc);
create unique index workers_voice_calls_provider_call on workers_voice_calls (provider, provider_call) where provider_call is not null;
