-- A lease on the platform's keys is charged per second to the tenant's credit: metered_until is how far it has been
-- charged, metered_seconds how long in all, at price_hour (micro-USD, fixed when it starts). hold is its end user's
-- credit, held from the start and settled once when it stops.
alter table computer_leases
  add column platform boolean not null default false,
  add column price_hour bigint,
  add column metered_until bigint,
  add column metered_seconds integer not null default 0,
  add column hold uuid,
  add column end_user text,
  add column bucket text;
create index computer_leases_metered on computer_leases (metered_until) where platform and state = 'active';
create index computer_leases_holds on computer_leases (id) where hold is not null;
