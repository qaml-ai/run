---
name: boat-agent-runtime
description: Run agent-runtime tests in a fresh Boat (boat.dev) sandbox instead of the laptop. For people with the team's Boat API key. Use when running test files or the full suite off the machine.
---

# agent-runtime on Boat

Needs the team's Boat API key in `BOAT_API_KEY` or `~/.config/boat/key`. Never print it, commit it or copy it into a
sandbox. Anyone without it runs tests as [AGENTS.md](../../../AGENTS.md#build-and-test) says. With your work committed:

```sh
scripts/boat-test                   # the full suite at HEAD; run it in the background
scripts/boat-test origin/fix/x      # the full suite at a ref
scripts/boat-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.ts
```

Each run starts its own `large` sandbox (8 vCPU, 16 GB, $0.072/h) from a saved snapshot, ships the committed tree only
(never `.env` or ignored files), runs the command detached, polls its log and deletes the sandbox. There is no pool and
no lease, so nobody waits. A full suite takes 9 to 22 minutes and costs $0.01 to $0.03; `BOAT_TYPE=default` (4 vCPU)
took 20 minutes for $0.01. A sandbox runs its first command within about 15 seconds. Postgres runs as CI's does
(`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`, 1000 connections).

The snapshot's name hashes `package-lock.json`, `sandbox/v8-exec` and the script's setup. A ref with new ones builds a
new snapshot first, about 3 minutes. The newest 3 are kept; 10 saved snapshots are free across the account.

The end of a run prints the sandbox id, exit status, cost, the local log path and CPU steal. Machines are shared: on a
busy host steal runs over 20%, a run takes twice as long and timing-sensitive tests can flake. Scattered failures with
high steal mean rerun those files, not a bug in your change. The full suite retries up to 3 failed files alone, as CI
does, so a run can pass with `Flaky test file` warnings; more than 3 failed files fail the run.

Exit status is the command's. A failure on Boat's side gets a fresh sandbox, up to twice (`BOAT_RETRIES`): no capacity (exit
75 if it stays so), a machine that died (137), or Postgres that did not start. Boat is never swapped for anything else, and a
failing command is never run again. Contact lost for 10 minutes follows the job again twice, then exits 69: the job carries
on, and `BOAT_ATTACH=<id> scripts/boat-test` follows it again and then deletes the sandbox. The same works after this script
itself was killed with SIGKILL; killed with TERM, as `timeout` does, it deletes its sandbox. At a start limit (429) the script
waits as long as Boat says and goes on; the plan allows 12 starts a minute, 60 an hour and 200 a day.

Each attempt ends with its exit line in the terminal and its log, and one line in `~/.config/boat/runs.jsonl` (no secrets or
test output). To see how runs have been ending:
`jq -r .cause ~/.config/boat/runs.jsonl | sort | uniq -c`. Causes: `ok`, `command_failed`, `out_of_capacity`, `machine_died`,
`contact_lost`, `postgres_not_started`, `killed` (a signal, usually the caller's), `other` (the script's own failure).

Test sandboxes get `noEnv`, no snapshots and no monitoring: no account secrets go in, and no disk copy or command
history stays at Boat after the delete. If this script dies, the sandbox is erased an hour after its last poll
(`BOAT_TTL_MINUTES`). `BOAT_KEEP=1` leaves it until then, to look around. Sandboxes run in the EU (Germany, Finland,
France), so source code goes to Boat's machines there. Saved snapshots hold dependencies and builds without the tracked
source, and Boat may store snapshot copies outside the EU.

Sandboxes have Docker.
