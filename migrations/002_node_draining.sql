-- A draining node still serves what it owns but takes nothing new; peers stop sending it work.
alter table runtime_nodes add column draining boolean not null default false;
