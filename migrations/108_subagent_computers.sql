-- Newly created sub-agents get a separate attachment by default.
alter table computer_connections add column subagents boolean not null default true;
