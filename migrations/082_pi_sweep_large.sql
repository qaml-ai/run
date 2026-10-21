-- The Pi sweep's pass for sessions too large to copy (src/pi-sweep.ts): off until the operator turns it on, one at a
-- time across the fleet (`large_until`, a lease), with its own cursor.
alter table pi_sweep add column large text not null default 'off' check (large in ('off', 'on'));
alter table pi_sweep add column large_cursor text not null default '';
alter table pi_sweep add column large_finished_at bigint;
alter table pi_sweep add column large_until bigint;
