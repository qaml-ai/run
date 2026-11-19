alter table agent_v2_receipt_archives
  add column inputs jsonb not null default '[]' check (jsonb_typeof(inputs) = 'array');
