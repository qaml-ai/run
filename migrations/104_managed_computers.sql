-- One row per managed computer: its id is the key its machine is created with, so a lost answer finds the same machine.
-- usage_since, usage_micros and usage_seconds are what the provider has reported for this machine, in its own period;
-- charged_micros is what has been charged for it in all. hold is its end user's credit, settled once when it ends.
create table managed_computers (
  id text primary key,
  tenant text not null,
  agent text not null,
  connection text not null references computer_connections(id),
  workspace text,
  machine text,
  platform boolean not null,
  usage_since text,
  usage_micros bigint not null default 0,
  usage_seconds bigint not null default 0,
  charged_micros bigint not null default 0,
  hold uuid,
  end_user text,
  bucket text,
  deadline bigint not null,
  created_at bigint not null,
  ended_at bigint
);
create unique index managed_computers_open on managed_computers (connection) where ended_at is null;
create index managed_computers_open_tenant on managed_computers (tenant) where ended_at is null;
create index managed_computers_holds on managed_computers (id) where hold is not null;
-- An operator's stop to an account's managed computers: no new ones start until it is lifted.
create table computer_blocks (
  tenant text primary key,
  blocked_by text not null,
  created_at bigint not null
);
