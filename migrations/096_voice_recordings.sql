-- Voice recordings (src/voice-sessions.ts, src/voice/recorder.ts): a session's audio as Ogg Opus, recorded only when
-- the tenant asks (POST /v1/voice/sessions/{id}/recording). While it records, its audio goes to object storage in
-- chunks (recordings/<tenant>/<id>/chunks/…), listed here in order; once it ends they are made into its files
-- (recordings/<tenant>/<id>/<name>), kept until expires_at, then deleted with the row.
create table voice_recordings (
  id text primary key,
  tenant text not null,
  session text not null,
  state text not null check (state in ('recording', 'stopping', 'finishing', 'ready', 'failed')),
  tracks text not null check (tracks in ('mixed', 'speakers')),
  -- maxMinutes, maxBytes, retentionHours, metadata: as it was started.
  options jsonb not null,
  -- The chunks' storage keys, in the order they were written.
  chunks jsonb not null default '[]',
  -- Audio bytes recorded so far (what maxBytes counts).
  bytes bigint not null default 0,
  started_at bigint not null,
  ended_at bigint,
  end_reason text,
  seconds numeric,
  -- [{name, contentType, bytes, seconds, speakerId?}] once ready.
  files jsonb,
  error text,
  expires_at bigint,
  updated_at bigint not null
);
-- One recording at a time per session.
create unique index voice_recordings_active on voice_recordings (session) where state in ('recording', 'stopping', 'finishing');
create index voice_recordings_tenant on voice_recordings (tenant, started_at desc, id);
create index voice_recordings_expires on voice_recordings (expires_at) where expires_at is not null;
