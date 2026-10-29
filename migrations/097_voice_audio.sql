-- Audio a voice session's bot played into its call (POST /v1/voice/sessions/{id}/audio): tracks heard, and seconds.
alter table voice_sessions add column if not exists tracks integer not null default 0;
alter table voice_sessions add column if not exists played_seconds numeric not null default 0;
