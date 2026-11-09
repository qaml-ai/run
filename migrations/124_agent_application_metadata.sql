-- Both backends store application data in the agent header.
create index agents_application_metadata_idx on agents using gin
  ((coalesce(header::jsonb->'metadata'->'application', header::jsonb->'config'->'metadata', '{}'::jsonb)) jsonb_path_ops);
