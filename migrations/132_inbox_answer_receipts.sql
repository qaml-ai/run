create table inbox_answer_receipts (
  tenant text not null,
  request_id text not null,
  answers_hash text not null,
  owner uuid not null,
  claimed_until timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant, request_id)
);
create index inbox_answer_receipts_created_at on inbox_answer_receipts(created_at);
