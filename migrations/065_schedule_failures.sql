-- A schedule's failed deliveries: attempts at its current occurrence (retried with a backoff, then given up), how many
-- occurrences in a row were given up, and the latest failure, which a successful delivery clears.
alter table schedules add column attempts integer not null default 0;
alter table schedules add column failures integer not null default 0;
alter table schedules add column last_error text;
alter table schedules add column last_error_at bigint;
