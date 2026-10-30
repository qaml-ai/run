-- Single-use capabilities. Only the hash is stored; receipts contain no file bytes or URLs.
create table computer_transfers (
  token_hash text primary key,
  tenant text not null,
  agent text not null,
  volume text not null,
  path text not null,
  method text not null check (method in ('GET', 'PUT')),
  max_bytes bigint not null,
  expires_at bigint not null,
  claimed_at bigint,
  entry jsonb,
  result jsonb,
  status integer
);
create index computer_transfers_expiry on computer_transfers(expires_at);
