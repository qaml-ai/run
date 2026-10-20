-- Durable model accounting outbox. The response and receipt commit together;
-- accounting workers consume receipts under row locks in their ledger transaction.
create table pi_usage_receipts (
  session_id text not null,
  entry_id bigint not null,
  tenant text not null,
  message jsonb not null,
  accounted boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (session_id, entry_id)
);
create index pi_usage_receipts_pending on pi_usage_receipts (created_at, session_id, entry_id) where not accounted;
