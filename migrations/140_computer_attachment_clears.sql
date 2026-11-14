-- A connection write and its pending hint invalidation commit together.
create table computer_attachment_clears (
  agent text primary key,
  token uuid not null,
  due_at timestamptz not null default now()
);
create index computer_attachment_clears_due on computer_attachment_clears (due_at);
