-- Voice sessions (src/voice-sessions.ts): calls camelRun holds for a tenant's bot, from the media credentials its app
-- forwarded. One node holds each (actor voice:<id> in actor_owners). The credentials are sealed and dropped at the end;
-- audio is never stored anywhere.
create table voice_sessions (
  id text primary key,
  tenant text not null,
  provider text not null,
  guild text not null,
  bot_user text not null,
  channel text not null,
  state text not null check (state in ('connecting', 'live', 'reconnecting', 'ended')),
  end_reason text,
  -- Sealed {sessionId, endpoint, token}; null once the session ended.
  sealed jsonb,
  -- What it was created with (delivery, limits, metering), as the API reads it back.
  options jsonb not null,
  -- Bumped by every change a node other than the owner must apply (credentials, options, the end).
  revision integer not null default 0,
  utterances integer not null default 0,
  speech_seconds integer not null default 0,
  -- What its transcriptions cost, micro-USD.
  cost bigint not null default 0,
  created_at bigint not null,
  started_at bigint,
  last_speech_at bigint,
  ended_at bigint,
  updated_at bigint not null
);
-- Discord keeps one voice connection per user per guild: so does camelRun, per tenant.
create unique index voice_sessions_live on voice_sessions (tenant, provider, guild, bot_user) where state <> 'ended';
create index voice_sessions_tenant on voice_sessions (tenant, created_at desc, id);
create index voice_sessions_open on voice_sessions (created_at) where state <> 'ended';
