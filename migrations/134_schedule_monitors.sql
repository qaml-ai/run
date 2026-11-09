-- Monitors (shared/monitors.ts): a repeating code schedule that carries a monitor's settings, state and counters.
-- Additive only: one nullable column, no default, no change to an existing column, key or index. A node still
-- running the previous release never names this column (its statements list their columns), so it reads and writes
-- schedules as before; a monitor it claims mid-deploy runs once as a plain code schedule, whose result nothing uses.
alter table schedules add column monitor jsonb;
