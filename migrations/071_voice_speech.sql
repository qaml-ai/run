-- Voice sessions that speak (src/voice-speech.ts): how many speeches each played, and the seconds of speech made.
alter table voice_sessions add column speeches integer not null default 0, add column spoken_seconds numeric not null default 0;
