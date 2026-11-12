# Swarm workflow evals

Evals for the swarm-workflow harness in [docs/design/swarm-workflows.md](../../docs/design/swarm-workflows.md): tiered
tasks, each with a fixed input, a hidden judge the agent never sees, and a budget cap. A run measures the judge's
score, the cost (total, by agent type, by model class, and the cache share), wall time, children and effects,
conflicts and retries, gaming (deleted, skipped or stubbed tests), and whether the agent chose to split the work.

The harness is written against the designed workflow API and runs today in **dry mode** on plain `delegate`, which
validates the tasks and the judges before the workflow object exists.

```sh
E=evals/workflows/run.ts; N="node --experimental-strip-types --disable-warning=ExperimentalWarning"
$N $E list                                   # tasks by tier
$N $E check                                  # every judge against its fixtures (reference, untouched, gamed); no model
AGENT_URL=… AGENT_RUNTIME_TOKEN=… $N $E run --tasks s-ts-port,s-esm-refactor --modes dry --workers fast,strong --label cmp
$N $E summary .agent-runtime/eval/workflows-cmp.jsonl
```

`check` also runs in CI (`tests/workflow-evals.test.ts`, on the host). `run` spends money and stays out of CI.

## Tasks

Only `input/` is ever uploaded. `hidden/`, `reference/`, `score.ts` and `generate.mjs` stay on the machine running
the harness. A task's `version` changes whenever its input, judge or prompt does; results of different versions are
not one series.

| Tier | Task | Status | Judge | Budget |
| --- | --- | --- | --- | --- |
| S | `s-ts-port`: port strkit, a 16-module JavaScript library, to TypeScript | ready | 22 hidden `node:test` cases (more than the 13 visible) against the port's `src/index.ts`, run with type stripping; `tsc --strict` under the judge's own tsconfig. Score 0.75 tests + 0.25 typecheck | $3, 30 min |
| S | `s-esm-refactor`: 50 CommonJS modules to ES modules, a printf formatter replaced by template literals | ready | 410 hidden calls (expected values from running the originals; `%d` truncation, `%j`, `%%` are traps), and each module must be clean ESM to count | $3, 30 min |
| N | `n-data-audit`: 20 CSV tables against their schema (non-code) | ready | Rubric: 26 planted defects across 16 tables (4 tables clean), matched on (table, column, kind); 0.6 recall + 0.25 precision + 0.15 right rows. The generator checks its own rules find exactly the planted set | $3, 30 min |
| M | `m-mustache-rust`: mustache.js → Rust | planned | mustache/spec v1.4.3, ~200 cases | ~$10, 45 min |
| M | `m-toml-go`: smol-toml v1.9.1 (TypeScript, 1.6k lines) → Go, standard library only | **ready** | toml-test v2.2.0, TOML 1.0: 205 valid, 474 invalid, 205 encoder cases, in a pinned judge image (`judge/Dockerfile`: Go 1.27.3; no network). 0.5 valid + 0.2 invalid + 0.3 encoder; a build failure scores 0, and wrapping a TOML library scores 0 and is flagged. Reference: BurntSushi/toml v1.6.0 vendored as the module (0.989) | $7, 90 min |
| M | `m-jsonschema-python`: @cfworker/json-schema (TS) → Python | planned | JSON-Schema-Test-Suite, drafts 2019-09 and 2020-12, ~1,300 cases | ~$30, 90 min |
| M | `m-commonmark-rust`: commonmark.js → Rust | planned | CommonMark spec 0.31.2, 652 examples plus smart punctuation, byte for byte | ~$50, 2 h |
| L | `l-lua-rust`: Lua 5.4 (C, ~30k lines) → Rust | planned | the official Lua 5.4 test suite plus a differential corpus against the C build | ~$5k, 3 days |
| L | `l-quickjs-rust`: QuickJS (C, ~75k lines) → Rust, the Bun-shaped run | planned | test262: every test the C build passes (~45k) | ~$20k, 2 weeks |

**Tier M** candidates are permissively licensed (BSD-2, BSD-3, MIT; the CommonMark examples are CC-BY-SA) and judged
by a suite every implementation of the format is held to, as Bun's TypeScript tests judged its Rust. Every one
builds and runs its judge in a 4-vCPU, no-network container, today's Cloudflare job limit. Their `task.json` names
the port and judge at a ref, the judge command and image, and the steps to prepare them. `m-toml-go` is built: Go's
standard library has JSON and needs no vendored modules, so its judge builds offline, and a port's commands speak
toml-test's protocol directly. A task with its own toolchain names its image directory in `judgeImage`; `run.ts`
builds it once (tagged by the directory's hash) and its fixtures are checked by `run.ts check` in docker, not in CI.

Dry-mode agents have no compiler, and a Go port that does not build scores 0. Until `job()` exists, a task can ask
for dry mode's stand-in (`"jobs": ["go"]`): the harness serves the orchestrator `go_build` and `go_decode` tools that
build the volume as it is in the judge image (never running toml-test) and answer the compiler's output. Sub-agents
do not get them, so the orchestrator runs the build round, as a workflow's `job()` would.

**Tier L** needs infrastructure phase 1 does not have (see each `task.json`'s `needs`):

- our own job hosts (phase 2) for cargo builds of a 30–75k-line crate, minutes each;
- sharded test runs on the spot pool (phase 4): test262 in ~32 shards a round;
- repositories (phase 3): 64 editors committing one file at a time onto one branch, with whole-tree search;
- `queue()` and 10,000+ effects (phase 4) for the compile-error work queue.

`l-lua-rust` is the dress rehearsal at a quarter of the size.

## Modes

| Mode | What runs | Needs |
| --- | --- | --- |
| `dry` | An orchestrator agent with `delegate` to `worker`, `critic` and `lead` definitions on the task's volume. No workflow object. | Today |
| `workflow` | The same agent and prompt. With delegate settings it also gets the `workflows` builtin, so whether it writes a workflow is its own choice, and is measured (`choice.workflowStarted`). The harness waits for each workflow it started, then reads its items and ledger. | Phase-1 PR 7 (`WorkflowObject`, `/v1/workflows`, the builtin) |
| `workflow-direct` | The harness starts the task's reference script (`tasks/<id>/workflow.js`) itself, so the runtime is measured apart from the agent's judgment. Children are made from the run's worker, critic and lead definitions, which mount the task's volume and carry the model class. | `/v1/workflows` (PR 7), or on a local TEST_MODE runtime the WorkflowObject's operator hook `/__test/workflows/:name` (#806) once the `agent()` executor (#804) is wired into it |

Workflow modes answer `unavailable` on a runtime without a workflow API, so the same command runs before and after
PR 7 (`--workflow-api auto|public|test-hook` picks the transport; `auto` tries the public route, then the hook). The
hook's shapes (create `{ code, budgetUsd, concurrency }`, `get`, `items` paged by `ord`) are pinned by a mock in
`tests/workflow-evals.test.ts`; a real local run needs a Workers checkout with #806 and #804 merged and wired, then
`--modes workflow-direct --workflow-api test-hook` against its `npm run dev`. The
model classes are the virtual models `camelrun/fast` (Muse Ember) and `camelrun/strong` (Gemini 4 Carbon on flex),
which exist today (#796); the orchestrator defaults to `camelrun/strong` (`--orchestrator` to change it, e.g. to
`camelrun/max` once it exists).

`--split required` adds one sentence to the orchestrator's prompt telling it to do no item work itself (the design's
orchestrator type). Without it, the agent chooses, and on Tier S a strong orchestrator often does the work alone.

**Adapter assumptions to check when PR 7 and PR 8 land** (all in `lib/runtime.ts` and the `workflow.js` files):

- `GET /v1/workflows?owner=<agentId>` lists an agent's workflows (`workflows` or `data` array);
- `GET /v1/workflows/:id/items` pages with `next` (the hook's is an `ord`, sent back as `after`) and takes
  `attempts=true`; items carry `kind`, `status`, `attempt`, `current`, `costUsd`, `model`, `reason` and `args` (as in
  #806), and cost by agent type comes from `args.definition` until items carry a `type`;
- `spent` on the workflow has `usd`, `inputTokens`, `cachedInputTokens`, `outputTokens`;
- the runner evaluates a script as an async function body (#806), so the harness strips `export` and inlines `args`
  as a const; if the public route passes `args` as a global, the const shadows it with the same value;
- `agent()` takes `definition` (#804); `type` is passed too and ignored until PR 8 makes it an option;
- usage rolled up under the orchestrator does not already include its workflows' children (else `mergeCost` double
  counts: compare with `GET /v1/usage` once).

## Choosing to split the work

`run.ts choice` scores whether the agent splits the work when it should. It reads 12 prompts in
`choice/prompts.json`: 6 should be split (400 module conversions, 60 translations, a 120-table audit with checks,
80 contract extractions with a second reader, a 150-file security review, a 40-source research sweep) and 6 should
not (a typo, a one-file question, a local rename, a one-doc summary, one table's total, a `.gitignore`). Each prompt
gets generated files, and each run stops at the agent's first decision, so the work is never paid for (about $0.05
a prompt). The decision is `split` when the agent:

- started a workflow whose script calls `agent()` (workflow mode). Agents also start workflows to run one command
  (only `job()`) or to look around (a script that lists its globals); those are counted (`otherWorkflows`) and the run
  goes on. Splitting with `delegate` instead is reported apart; or
- started at least two sub-agents in its first turn (dry mode).

The summary gives accuracy, how often the agent split when it should, and how often it split when it should not, for
each wording. The wording the agent decides from is the delegate tool's and the orchestrator's prompt today, and the
`workflows` builtin's description once PR 7 lands (design open question 13). `--guidance <file>` appends candidate
wording to the orchestrator's prompt, to compare drafts before one ships. `choice/guidance/` holds the wordings tried so far (`design-draft.md`, the design's draft adapted to `delegate`;
`triggers.md`, `example.md`, `cost.md`, `plan-fanout.md`, `combined.md`, for choosing `agent()` workflows; and
`no-poll.md`, for waiting on notifications). `run.ts run --guidance <file>` gives a task run the same wording, so a
wording that wins the choice eval can be checked on a real task.

`run.ts polling [--guidance …]` counts how the owner waits (`choice/polling.json`: a one-job workflow, two jobs of
different lengths, three worker agents). Each prompt runs to its end, and the summary reports `workflow_status`
calls per workflow against the notifications the owner got, and whether it replied after the last one.

`run.ts run --wall-minutes <n>` tightens a task's wall cap, for runs where splitting the work has to win on time.

```sh
… run.ts choice --modes dry --guidance none,evals/workflows/choice/guidance/design-draft.md --label choice-baseline
… run.ts choice --modes workflow --label choice-builtin        # once the builtin exists
```

## Workflow mode

The agent gets the task, delegate settings (so the `workflows` builtin is on) and one added sentence: which volume its
`/workspace` is, since `agent(…, { repo })` and `job({ at })` take a volume id; plus the task's `workflowNote` (what a
job's container has). Whether it writes a workflow is its own choice. The harness reads each workflow id from
`workflow_start`'s answer, waits for every workflow to end, then for the agent to go idle, and reads its history:

- `notifications`: the workflow notifications it got (user messages the runtime writes with `metadata.kind:
  "workflow"`), whether it wrote text after the last one (it reported back), and its `workflow_status` calls (polling);
- `choice.workflowAgents`, `choice.workflowJobs`: a workflow with jobs and no agents ran commands; it did not split
  the work;
- the cost is the tenant's spend across the run (runs are serialized), so children, jobs (`computer:cloudflare/…`)
  and the owner all count once, however usage rolls up;
- `failures`: model errors and retries, failed sub-agents, failed or refused effects, faults, and with
  `--runtime-log` the runtime's own error lines during the run.

## Comparison runs

```sh
# Workers on fast against strong (the design's first class eval), with the orchestrator splitting the work:
… run --tasks s-ts-port,s-esm-refactor,n-data-audit --modes dry --workers fast,strong --split required --runs 3 --label classes
# Workflow against plain delegate on Tier S (after PR 7):
… run --modes dry,workflow,workflow-direct --workers fast --runs 3 --label wf-vs-delegate
# auto, later: add `auto` to CLASS_MODELS once camelrun/auto exists, and pass --workers fast,strong,auto.
```

The summary reports cost per point of score (`cost/point`), the design's bar for the class eval: cost per merged task
down by a third or more at quality within 2%.

## Metrics

| Field | Meaning |
| --- | --- |
| `score` | The hidden judge's value (0–1), passes, failures, the expected count, and task checks (type errors, unclean modules, recall and precision) |
| `integrity` | What the output did to dodge the judge: test files deleted, cases removed, skip/todo/only markers added (`node:test`, Jest/Mocha, Rust `#[ignore]`, pytest, Go `t.Skip`), stubs (`not implemented` throws, `todo!()`, `unimplemented!()`, `NotImplementedError`), `@ts-ignore`/`@ts-nocheck`/`as any`, protected files edited; for rubric tasks, a shotgun list. `gamingSuspected` if any. The judge never counts a skipped test as a pass, and runs its own copy of the tests, so an edited test changes the flag, not the score |
| `cost` | Total USD, by agent type (orchestrator, worker, critic, lead), by served model and by model class, tokens, `cacheShare` (cache reads over all input). From `GET /v1/agents/:id/usage?groupBy=definition,model&rollup=true`, plus the workflow ledger in workflow modes |
| `wallMs`, `status` | Wall time; completed, budget (the spend cap stopped it), timeout, failed, unavailable or error |
| `effects` | Children and grandchildren and their statuses; in workflow modes, effects and jobs too |
| `conflicts`, `retries` | Write conflicts the agents' tools reported; effects re-run under a later attempt (workflow modes; null in dry mode) |
| `choice` | Whether it delegated, how many delegate calls, whether it started a workflow, and every tool it called |

Each run writes `.agent-runtime/eval/workflows-<label>/<task>-<mode>-<workers>-<n>/` (`result.json`, `events.jsonl`
with the orchestrator's calls and replies, `output/` with the final tree) and a line in
`.agent-runtime/eval/workflows-<label>.jsonl`; the markdown summary goes to `workflows-<label>.md`. camelRun has no
eval viewer of its own, so reporting is JSON plus markdown, as `scripts/eval-agent.ts` does.

## Where it runs, and keys

Never on a production tenant: the harness refuses `run.camelai.com`, `agents.camelai.dev` and other hosts it does not
know (`--allow-host` for another dev runtime). Keys come from the environment only and are never written to results.

- **The pilot** (`https://run-pilot.camelai.dev`): `AGENT_RUNTIME_TOKEN` is a pilot tenant API key. An operator mints
  one with `node backends/workers/scripts/pilot-admin-key.mjs` in their own terminal (see `backends/workers/PILOT.md`)
  and keeps it in a password manager. The pilot's platform OpenRouter key pays for model calls.
- **A local Workers dev runtime** with workflows on and `job()` on local Docker (`local-runtime.ts`):

  ```sh
  (cd backends/workers && npm ci)
  OPENROUTER_API_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning evals/workflows/local-runtime.ts > rt.log 2>&1 &
  AGENT_URL=http://127.0.0.1:8788 AGENT_RUNTIME_TOKEN=local-integration-only-token-with-at-least-32-characters \
    … run.ts run --modes workflow --runtime-log rt.log …
  node … evals/workflows/local-runtime.ts --stop        # removes the database, and the key stored in it
  ```

  It derives a config from `wrangler.computers.test.jsonc` (the jobs e2e's) into `backends/workers/.wrangler/evals/`
  (gitignored): real models, `AGENT_WORKFLOW_TENANTS` for the local tenant, a throwaway `.dev.vars` encryption key, and
  a job image that adds Go 1.27.3 to the computers image (phase 1's `job()` has one image; the pilot's has no Go yet).
  It stores `OPENROUTER_API_KEY` on the local tenant through the API. The token is the local fixture operator token,
  not a credential. `--checkout <dir>` runs another checkout's Workers app, e.g. an unmerged branch.

  Run it from a checkout nobody edits while evals run (`git worktree add --detach ../evals-rt origin/main`, then
  `--checkout ../evals-rt`): `wrangler dev` reloads when its checkout changes, a reload resets every Durable Object,
  and the owner's turn ends `interrupted` (it cost one s-esm-refactor run). With `--runtime-log`, each run keeps its
  slice of the runtime's output as `runtime.log` beside `events.jsonl`.

Judges run model-written code, so by default they run in a throwaway `node:22.21.1-bookworm-slim` container with no
network, 4 CPUs and 4 GiB (`--sandbox host` only for trees you trust; the CI self-test uses it on fixtures).

## Adding a task

1. `tasks/<id>/task.json` (see `lib/types.ts`), `input/` (what the agent gets), `hidden/` (the judge's files), and
   `score.ts` exporting `score({ tree, input, judge, sandbox })` built from `lib/score.ts`'s helpers. Generated inputs
   keep their generator beside them and commit its output.
2. Fixtures in `lib/tasks.ts`: a reference solution that scores near 1, the untouched input, and at least one gamed
   solution that must be flagged. `run.ts check` and the CI test hold them.
3. A reference `workflow.js` for workflow-direct mode.
4. The prompt is model-facing: keep it plain, and review wording changes.
