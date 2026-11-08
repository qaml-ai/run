create table inbox_answer_receipts (
  tenant text not null,
  request_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant, request_id)
);
