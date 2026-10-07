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

## An example session: the goal nothing has reached

The goal is "an acquire tried again after a heartbeat expired between its statements" (src/ownership.ts). An acquire's
insert has to see the current owner's heartbeat as live, and the next statement has to see it as expired. Two
statements at one virtual time see one `now()`, so time must pass between them. One way is a pause: a paused node's
database answers wait until the pause ends.

1. Call `goals` with `context: 6`. It shows the acquire loop and confirms the goal is not reached.
2. Call `schema`. The ops you need are `create`, `prompt`, `crash`, `pause` and `isolate`, and `leaseTtlMs`.
3. Write a plan with nodes a and b, a 3000 ms lease, and the agent made on a. Prompt it through b, so b asks a and a
   owns it. Crash a. Then, just before a's heartbeat expires, prompt the agent through b again, so b tries to take
   it, and pause b for a few heartbeats right then.
4. Call `run_plan`. Read `newGoals`. If the goal was missed, use `inspect` with `logs: "/acquire|heartbeat|owner/"` and
   `state: true` to see when a's heartbeat ended relative to b's acquire.
5. Shift the timing, by hand or with `branch` (`k` = the steps before the pause, `n` = 10).
6. Once a run reaches the goal, call `corpus_add` with a note, so the fuzzer builds on it.
