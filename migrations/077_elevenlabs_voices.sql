-- Only voices successfully added by camelRun are eligible for slot eviction. Keys are SHA-256 identities, never credentials.
create table elevenlabs_voices (
  key_hash text not null,
  voice_id text not null,
  added_at bigint not null,
  last_used_at bigint not null,
  primary key (key_hash, voice_id)
);
create index elevenlabs_voices_lru on elevenlabs_voices (key_hash, last_used_at, added_at, voice_id);
