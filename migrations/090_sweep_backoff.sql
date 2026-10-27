-- A sweep reserves its next attempt before loading, so a node crash keeps the delay.
alter table agents add column sweep_failures integer not null default 0;
alter table agents add column sweep_after bigint;
