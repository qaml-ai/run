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
| M | `m-toml-go`: smol-toml (TS) → Go | planned | toml-lang/toml-test v2.2.0, ~700 decoder cases plus encoder | ~$30, 90 min |
| M | `m-jsonschema-python`: @cfworker/json-schema (TS) → Python | planned | JSON-Schema-Test-Suite, drafts 2019-09 and 2020-12, ~1,300 cases | ~$30, 90 min |
| M | `m-commonmark-rust`: commonmark.js → Rust | planned | CommonMark spec 0.31.2, 652 examples plus smart punctuation, byte for byte | ~$50, 2 h |
| L | `l-lua-rust`: Lua 5.4 (C, ~30k lines) → Rust | planned | the official Lua 5.4 test suite plus a differential corpus against the C build | ~$5k, 3 days |
| L | `l-quickjs-rust`: QuickJS (C, ~75k lines) → Rust, the Bun-shaped run | planned | test262: every test the C build passes (~45k) | ~$20k, 2 weeks |

**Tier M** candidates are permissively licensed (BSD-2, BSD-3, MIT; the CommonMark examples are CC-BY-SA) and judged
by a suite every implementation of the format is held to, as Bun's TypeScript tests judged its Rust. Every one
builds and runs its judge in a 4-vCPU, no-network container, today's Cloudflare job limit. Their `task.json` names
the port and judge at a ref, the judge command and image, and the steps to prepare them. Build `m-mustache-rust`
first: it is cheap and shakes out the judge images and `job()`.

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
| `workflow-direct` | The harness starts the task's reference script (`tasks/<id>/workflow.js`) with `POST /v1/workflows`, so the runtime is measured apart from the agent's judgment. | PR 7; `type`/`class` on `agent()` need PR 8 |

Workflow modes answer `unavailable` on a runtime without `/v1/workflows`, so the same command runs before and after
PR 7. The model classes are the virtual models `camelrun/fast` (Muse Ember) and `camelrun/strong` (Gemini 4 Carbon
on flex), which exist today (#796); the orchestrator defaults to `camelrun/strong` (`--orchestrator` to change it,
e.g. to `camelrun/max` once it exists).

`--split required` adds one sentence to the orchestrator's prompt telling it to do no item work itself (the design's
orchestrator type). Without it, the agent chooses, and on Tier S a strong orchestrator often does the work alone.

**Adapter assumptions to check when PR 7 and PR 8 land** (all in `lib/runtime.ts` and the `workflow.js` files):

- `GET /v1/workflows?owner=<agentId>` lists an agent's workflows (`workflows` or `data` array);
- `GET /v1/workflows/:id/items` pages with `next`, and items carry `kind`, `status`, `attempt`, `costUsd`, `model`,
  `error`, and ideally `type`, for cost by agent type;
- `spent` on the workflow has `usd`, `inputTokens`, `cachedInputTokens`, `outputTokens`;
- a child reaches the task's volume through `agent(…, { files: { volume, path, mode } })`;
- usage rolled up under the orchestrator does not already include its workflows' children (else `mergeCost` double
  counts: compare with `GET /v1/usage` once).

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
- **A local Workers dev runtime** (what the first dry runs used):

  ```sh
  (cd backends/workers && npm ci && node scripts/local-postgres.mjs)
  # backends/workers/.dev.vars (gitignored): a throwaway encryption key, and real models instead of test/echo
  printf 'AGENT_SECRETS_KEY=%s\nTEST_MODEL=0\nMODEL=camelrun/default\n' "$(openssl rand -hex 32)" > backends/workers/.dev.vars
  (cd backends/workers && npm run dev)        # prints its port
  # Store your OpenRouter key on the local tenant from the environment (never on the command line):
  node -e 'fetch(process.argv[1]+"/v1/providers/openrouter/key",{method:"PUT",headers:{authorization:"Bearer "+process.argv[2],"content-type":"application/json"},body:JSON.stringify({apiKey:process.env.OPENROUTER_API_KEY})}).then(r=>console.log(r.status))' \
    http://127.0.0.1:8788 local-integration-only-token-with-at-least-32-characters
  AGENT_URL=http://127.0.0.1:8788 AGENT_RUNTIME_TOKEN=local-integration-only-token-with-at-least-32-characters … run …
  ```

  The token is the local fixture operator token in `wrangler.jsonc`, not a credential. `node scripts/local-postgres.mjs --stop`
  removes the database and the key stored in it.

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
