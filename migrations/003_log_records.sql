-- The hot tail of each log in Storage (agent journals and transcripts, volume
-- trees): records appended while an actor is owned, until compaction folds them
-- into one Storage segment. See src/log-tail.ts.
create table log_records (
  log_key text not null,
  seq bigint not null,
  -- The actor whose claim fenced the insert; null for a log written without one.
  actor text,
  -- The row replaces the log so far: `body` is a JSON array of records.
  snapshot boolean not null default false,
  -- The record as JSON text, or null when it is in Storage as blob `<log>/blob-<blob>`.
  body text,
  blob text,
  primary key (log_key, seq),
  check ((body is null) <> (blob is null))
);
create index log_records_actor on log_records (actor);
