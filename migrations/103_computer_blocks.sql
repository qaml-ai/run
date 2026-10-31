-- An operator's stop to an account's managed computers: no new ones start until it is lifted.
create table computer_blocks (
  tenant text primary key,
  blocked_by text not null,
  created_at bigint not null
);
