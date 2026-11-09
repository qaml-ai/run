-- migrate: concurrently
-- Both backends store application data in the agent header. Keep agent writes available during the build.
create index concurrently if not exists agents_application_metadata_idx on agents using gin
  ((coalesce(header::jsonb->'metadata'->'application', header::jsonb->'config'->'metadata', '{}'::jsonb)) jsonb_path_ops);
