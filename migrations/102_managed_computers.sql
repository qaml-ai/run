-- A managed connection runs on the platform's Boat key, or an admin's for the tenant, with no credentials of its own.
-- Its lease_seconds is how long a computer outlives its latest command, which may be longer than a provider connection's fixed 15 minutes.
alter table computer_connections add column managed boolean not null default false;
alter table computer_connections drop constraint computer_connections_lease_seconds_check;
alter table computer_connections add constraint computer_connections_lease_seconds_check check (lease_seconds between 60 and 86400);
