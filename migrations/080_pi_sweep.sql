-- The Pi migration sweep (src/pi-sweep.ts): one row. `mode` is the operator's (PUT /v1/operations/pi-sweep), capped by
-- each node's AGENT_PI_SWEEP; it starts in dry-run, so turning the setting on reports before anything migrates.
-- Each mode walks agents in id order from its own cursor; a pass that reaches the end records when, and the next waits.
create table pi_sweep (
  id boolean primary key default true check (id),
  mode text not null default 'dry-run' check (mode in ('off', 'dry-run', 'on')),
  dry_run_cursor text not null default '',
  on_cursor text not null default '',
  dry_run_finished_at bigint,
  on_finished_at bigint,
  updated_at bigint not null default 0
);
insert into pi_sweep (id) values (true);
