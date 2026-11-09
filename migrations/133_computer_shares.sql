-- NULL owner explicitly disables a child's native computer.
-- A sharing child owns no connection or machine. Resolve directly to the original owner.
create table computer_shares (
  tenant text not null,
  agent text primary key references agents(id) on delete cascade,
  owner text references agents(id) on delete cascade,
  check (agent <> owner)
);
create index computer_shares_owner on computer_shares(owner);

-- Reservations exclude simultaneous starts before the provider answers.
create table computer_slots (
  tenant text not null,
  machine text not null,
  root text not null,
  expires_at bigint not null,
  acquired_at bigint not null default 0,
  in_flight integer not null default 0,
  busy_until bigint not null default 0,
  primary key (tenant,machine)
);
create index computer_slots_root on computer_slots(tenant,root,expires_at);
