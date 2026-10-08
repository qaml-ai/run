# The simulator over MCP

`npm run -s sim:mcp` serves the deterministic simulator (see "The simulator" in docs/operations/architecture.md) as an
MCP server over stdio, so an agent such as Claude Code can write plans, run them, look into the runs and keep the good
ones in the fuzzing corpus. The server has no network listener, and it runs one sim at a time, within its caps:

- 30 virtual minutes, 400 steps and 5 nodes per plan;
- 100 seeds or 15 minutes per batch;
- 30 fuzzing minutes per call.

Every run keeps its leak detector on.

## Adding it to Claude Code

Locally, from a checkout:

```sh
claude mcp add camelrun-sim -- npm --prefix /path/to/run run -s sim:mcp
```

On the devbox, over ssh. The server's stdio is the ssh session's, so nothing else is needed:

```sh
claude mcp add camelrun-sim-devbox -- ssh camel-devbox 'cd ~/agent-runtime && npm run -s sim:mcp'
```

## Tools

| Tool | What it gives |
|---|---|
| `schema` | The plan format (JSON Schema), with every op and fault and its parameters. Also the caps, one line per checker (I1, I2, I3, ...), the BUGGIFY sites, and an example plan. |
| `goals` | Every coverage goal: where it is in the source, and whether this server's runs or the corpus reached it. `all` adds the always/unreachable points; `context` adds source lines around each. |
| `run_plan` | Validates the plan, then runs it. Gives failures, goals newly reached, new coverage (blocks of `src/` and `shared/` no earlier run here covered), BUGGIFY sites fired, the hash, and the client calls step by step, plus a run id. `twice` checks determinism. |
| `run_seeds`, `fuzz` | A batch of generated seeds, or a fuzzing session that draws on the corpus and adds to it. Gives the failures and the interesting runs or plans, by id. |
| `inspect` | Slices of a run: logs (substring or `/regex/`), history, trace, an agent as the run left it (its requests, state and history), and the ownership, heartbeat and pending-run rows. |
| `minimize`, `replay`, `branch` | Cut a failing run down; run a run, corpus entry or saved file again; keep a run's first k steps and redraw the rest, n times. |
| `corpus_add`, `corpus_list` | Keep a run's plan in `sim-corpus/` with a note, and list what is there. |

Runs are recorded under `sim-mcp/` (gitignored), so `inspect` and `replay` work on any run of the session.

## An example session: a race between two statements

The goal "an acquire tried again after a heartbeat expired between its statements" (src/ownership.ts) needs an
acquire's insert to see the current owner's heartbeat as live, and its next statement to see it as expired. Two
statements at one virtual time see one `now()`, so time must pass between them, and `pauseOnDb` puts it exactly there:
the node stops as it hears the answer to a given statement. `tests/sim/corpus/acquire-owner-expiry.json` is such a
plan; this is how one finds it.

1. Call `goals` with `context: 8`. It shows the acquire loop: an insert, then an owner query.
2. Call `schema`. You need `create`, `prompt`, `crash`, `databaseDown`/`databaseUp` and `pauseOnDb`.
3. Make the agent on a and crash a: its heartbeat now expires on its own, a lease later. b serves an agent it does not
   own only if its route (an owner query) fails, so cut b off the database and prompt through b with a `pauseOnDb` on
   `from actor_owners o join runtime_nodes`: b hears the failure late, the database is back by then
   (`databaseUp`), and b takes the agent itself.
4. Arm a second `pauseOnDb` on `insert into actor_owners` for longer than what is left of a's heartbeat. The insert sees
   a as live and takes nothing; b hears that after a's heartbeat expired, so its owner query finds no one.
5. Call `run_plan` and read `newGoals`. If it was missed, `inspect` with `logs: "/heartbeat|fence|reap/"` and
   `state: true` shows the timings; `branch` (`k` = the steps before the pauses) varies the rest.
6. Keep it with `corpus_add`, with a note.
