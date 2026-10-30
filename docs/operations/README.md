# Operating the agent runtime

These pages are for people who run the agent runtime or work on its code: how it is built, configured,
deployed and billed, and what isolates tenants and generated code. To build on the hosted runtime, start
with the [Quickstart](../quickstart.md) and [Concepts](../concepts.md) instead.

- [Architecture](architecture.md): control and data planes, ownership, logs, draining, deploys, turn handoff
- [Release notes](release-notes.md): rollout requirements and incompatible changes
- [Configuration](configuration.md): environment variables, starting a runtime
- [Managed Discord](managed-discord.md): the shared Camel application, onboarding, platform secrets and pilot checks
- [Self-hosting](self-host.md): the image, Docker Compose, storage, networking
- [Persistence](persistence.md): transcripts, history chunks, journals, retries, idle unload, limits per node and tenant
- [Backups and restore](backup-restore.md): what is kept and for how long, the restore drill, restoring production
- [Journal checkpoint reclaim](journal-reclaim.md): size and remove superseded context copies in idle sessions
- [Pi durable sessions](pi-durable.md): the execution engine, importing legacy sessions, storage, recovery and billing
- [Vendored Pi](pi-vendoring.md): Pi built from a commit into `vendor/pi/`; bumping it; versions that cannot be rolled back
- [Billing](billing.md): prepaid credit, the ledger, storage metering, Stripe, which keys a tenant's calls use
- [Tenants](tenants.md): admin tenants and `infra/tenant.sh`: tokens, keys, agent and spend limits, other limits
- [Anthropic federation](anthropic-federation.md): platform Anthropic credentials from the ECS task role
- [Model endpoints](model-endpoints.md): a tenant's model calls through a pass-through gateway of the operator's
- [Account data](privacy.md): export, deletion, what is kept and for how long; handling requests by email
- [Account email](account-email.md): sign-up, password reset and adding a password by email; SES setup
- [Ops dashboard](admin-analytics.md): the team's dashboard at run.camelai.com/ops: Cloudflare Access, deployment, and what each figure counts
- [Tenant isolation](isolation.md)
- [Sandbox](sandbox.md): the codemode sandbox's layers and limits
- [Voice pipeline](voice-pipeline.md): media workers, the control/media protocol, streaming, audio hygiene, turn latency
- [Integration seam](integration.md)

## Pending removals

- **Token sessions' columns, once the release with password sign-in runs everywhere.** Token sign-in is gone
  (migration 054 ended its sessions), but `console_sessions.token_id`, `operator_sha256`, their check and the
  `token` method stay allowed so that nodes on the release before keep working while a deploy rolls out. A
  later migration drops the two columns and the table's check on them, takes `'token'` out of
  `console_sessions_method_check`, and `ConsoleAuth.principal` (`src/console-auth.ts`) stops filtering
  `method <> 'token'`.

## Layout

- `src/` server, supervisor, agent host, sessions, scheduler, REST API, sandbox
- `migrations/` Postgres schema, applied at startup
- `shared/` storage backends (file, S3), wire protocol
- `vendor/pi/` Pi's packages, built from one commit of its main branch (`scripts/vendor-pi.sh`, [Vendored Pi](pi-vendoring.md))
- `clients/` TypeScript and Python SDKs; `sdk/` publishes `@camelai/run`
- `console/` tenant console (React); `studio/` local chat/trace UI
- `infra/` AWS provisioning and deploy scripts; `deploy/smoke.ts` live smoke test; `deploy/selfhost/` Docker Compose for self-hosting
- `tests/` Node test suites (no paid model calls)

## Develop

Requires Node 22.21+, npm, Postgres 14+ and Rust (rustup: `sandbox/v8-exec/rust-toolchain.toml`
pins the toolchain) for the js_exec engine, `v8-exec`, which every js_exec runs on: build it once,
and again after changing `sandbox/v8-exec`. The tests expect a disposable
database at `postgres://postgres:test@127.0.0.1:55432/postgres` (override with
`AGENT_TEST_DATABASE_URL`); each test gets its own schema, dropped afterwards:

```sh
docker run -d --name agent-runtime-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
```

```sh
npm ci
npm run build:v8-exec            # js_exec's engine; the runtime and the js_exec tests need it
npm run typecheck
npm test                         # agents in their own processes
AGENT_HOSTING=inline npm test    # agents inline in the server process
npm run test:python              # needs clients/python/requirements.txt
npm run openapi                  # regenerate openapi.json after changing /v1 routes
```

The storage tests also run against S3 with `AGENT_TEST_S3_BUCKET=<bucket>`.
`npm run studio` and `npm run demo:clients` need `AGENT_DATABASE_URL`.

### CI and deploys

Every main commit's CI (`.github/workflows/ci.yml`) is its deploy gate: Deploy (`deploy.yml`) rolls the commit out
once all of CI passes, from the image CI's `publish` job already pushed. The gate is typecheck, builds and UI tests
(`checks`), the Python SDK (`python`), the whole suite in both hosting modes (`test`: five shards each), docs and API
tests (`docs`), the simulator's fixed seeds (`sim`) and both image architectures (`image`). Same-repository PRs, main
and dispatches run on Blacksmith; fork PRs use standard GitHub runners, including native ARM64.

A draft PR (by its state when the run starts, not the event's) runs only `checks`, `docs` and `changed tests`: the
test files it changes, and those named after the source files it changes (`src/foo.ts` runs `tests/foo.test.ts` and
`tests/foo-*.test.ts`, up to 40 files). A draft run never reports `CI success`. While iterating on a change, open
it as a draft. Marking it ready starts the ready-PR checks.

Ready PRs run five process shards, Python, fixed simulator seeds and, when image inputs change, an amd64 image
check. `scripts/test-select.ts` follows relative TypeScript imports (including re-exports and literal dynamic
imports) from changed files to test files. It adds five fast smoke files: agent-host, code-executor, model-errors,
history and config. These cover host lifecycle, sandbox execution, provider errors, history and configuration in
about ten seconds of recorded process time. `CI success` requires the selected suite to pass; it always reports
a result on ready PRs. Simulator test files run in these process shards because their nodes host inline internally.

Package files, tsconfig files, test helpers, test scripts, migrations, workflows, sandbox or Dockerfile changes run
all test files. Changes outside the import graph, an empty diff, selector/API errors or a selection above 40% also
run all files. PRs still use only process hosting on fallback; main and manual runs always use both modes.
Static selection cannot see computed imports or runtime file reads, so the smoke set and full main run remain
necessary. `npm run test:affected` uses the same selector against `git merge-base origin/main HEAD` and runs the
files locally in process mode by default; `AGENT_HOSTING=inline npm run test:affected` selects inline hosting.
It includes tracked working-tree edits, with the same Postgres and sandbox prerequisites as other runtime tests.

On main, `reuse` looks for the exact checkout tree recorded by a successful same-repository PR run within 14 days.
It requires the whole `ci.yml` run and its `CI success`, checks, docs, Python, simulator and process jobs to pass.
A match skips `checks`, `docs`, `python` and `sim`; it skips process shards only if the PR ran the full process
suite. A selected PR suite never replaces the full process suite. Inline shards, both image architectures and
`publish` still run. Missing proof or an API error runs the normal checks. `CI success` accepts these skips only
with verified reuse on a main push; Deploy still requires that main CI run to succeed.

On failure, `CI success` writes the commit SHA, associated PR and last earlier green main SHA to the job summary. It does not
bisect automatically. Superseded PR and branch runs are cancelled; each main SHA runs independently so Deploy
receives its completed CI event. Four hundred fresh simulator seeds run every night (`sim-seeds.yml`; run it by
hand for more): a seed that finds something new turns that run red.

Runner sizes follow job timings. The test shards and `python` are CPU-bound and keep eight vCPUs (on four, shards
took 170-450 s instead of 115-165 s); `checks`, `docs` and `changed tests` finish within a minute on four. The fixed
seeds use 16 vCPUs, and image builds keep 16 for cache misses. Deploy waits on ECS on two ARM vCPUs. `changes` and
`CI success` stay on GitHub's runners, on the critical path: they pick a job up in one to three seconds, Blacksmith
in seven to seventeen.

The shards are balanced by `tests/timings.json`. Each shard records its files' times as a `test-timings-*`
artifact; when shards drift apart, rebalance from a few green runs (a file's time is its mean over them):

```sh
for id in <run id>...; do gh run download $id -R qaml-ai/run -p 'test-timings-*' -D /tmp/timings/$id; done
npm run test:shard -- --update /tmp/timings/*
npm run test:shard -- --plan 5   # what each shard runs, and its expected seconds
```

A shard whose failures are in at most three files runs those files once more, alone; if they pass, the shard passes
and the run carries a "Flaky test file" warning naming each one. Treat that warning as a bug to fix (a fixed wait or a
short deadline that a busy runner misses is the usual cause), not as green. More failing files fail the shard at once.

**Hotfix** (a merged fix, live without waiting for CI or for the deploys queued before it):

```sh
gh workflow run deploy.yml -R qaml-ai/run -f sha=<commit on main> && sleep 5 && gh run watch -R qaml-ai/run $(gh run list -R qaml-ai/run -w deploy.yml -e workflow_dispatch -L 1 --json databaseId -q '.[0].databaseId')
```

Leave out `-f sha=…` to deploy main's head. A hand-run Deploy uses CI's image when the `publish` job has pushed it
(about a minute after the merge) and builds it otherwise. It runs in its own concurrency lane
(`deploy-production-manual`), so an automatic deploy neither cancels it nor makes it wait, and it logs the rollout as
it goes: ECS's service events, each deployment's running tasks, healthy new tasks, then `rollout COMPLETED` and the
running image check. New tasks serve about 1.5 minutes after the update; the rollout completes once the old tasks'
protected turns are handed off (usually 2–7 minutes more, at most `AGENT_RETIRE_MAX_MS`).

Only commits on main deploy, and never over a newer one. Every deploy, automatic or by hand, compares its commit with
the image of the service's primary deployment right before `update-service`: when that deployment already includes
the commit (the same commit, or a later one), it registers nothing and follows that deployment to completion instead;
a deploy that a later commit replaces mid-rollout follows that one. To roll back on purpose, add `-f rollback=true`.
Automatic deploys run one at a time; a newer commit's deploy cancels the older run (only its wait: ECS carries on) and
supersedes its rollout. A run that ends green has seen every running task on an image that includes its commit, by tag
and by ECR digest; the run's title names the commit it deploys (the run list's commit column shows main's head when CI
finished instead).

### CI test isolation

Every test job uses its own Postgres container and allocated port; Docker commands target the exact service
container ID. Blacksmith test shards run eight files at a time (`TEST_CONCURRENCY`), fork shards two. The nightly
run uses two file workers.
Python dependencies live in a checkout-local virtual environment. Manual CI dispatch does not trigger deployment.
