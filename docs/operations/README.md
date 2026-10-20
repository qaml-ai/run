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
- [Billing](billing.md): prepaid credit, the ledger, storage metering, Stripe, which keys a tenant's calls use
- [Tenants](tenants.md): admin tenants and `infra/tenant.sh`: tokens, keys, agent and spend limits, other limits
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
(`checks`), the Python SDK (`python`), the whole suite in both hosting modes (`test`: five shards each on
Blacksmith, twelve on standard runners), docs and API tests (`docs`), the simulator's fixed seeds (`sim`)
and both image architectures (`image`). Ready same-repository PRs use Blacksmith; draft and fork PRs use
standard GitHub runners, including native ARM64. Marking a draft ready starts a new CI run.

On main, `scripts/ci-changes.sh` can prove that a successful same-repository PR run tested this exact
merge tree. Only that proof skips checks, Python, test shards, fixed seeds, image smoke tests and docs;
`publish` must still succeed before `CI success` passes. Missing artifacts, API errors, a changed tree
or a changed PR head run the checks normally. Superseded PR and branch runs are cancelled; each main
SHA runs independently so Deploy receives its completed CI event. Fifty fresh simulator seeds run beside it on every
main commit (`sim-seeds.yml`): a seed that finds something new turns that run red without holding the deploy back.

The shards are balanced by `tests/timings.json`. Each shard records its files' times as a `test-timings-*`
artifact; when shards drift apart, rebalance from a few green runs (a file's time is its mean over them):

```sh
for id in <run id>...; do gh run download $id -R qaml-ai/run -p 'test-timings-*' -D /tmp/timings/$id; done
npm run test:shard -- --update /tmp/timings/*
npm run test:shard -- --plan 12   # what each shard runs, and its expected seconds
```

A shard whose failures are in at most three files runs those files once more, alone; if they pass, the shard passes
and the run carries a "Flaky test file" warning naming each one. Treat that warning as a bug to fix (a fixed wait or a
short deadline that a busy runner misses is the usual cause), not as green. More failing files fail the shard at once.

To deploy without waiting for CI (an emergency fix, or a rollback to an earlier commit), run Deploy by hand:
`gh workflow run deploy.yml -R qaml-ai/run --ref <branch or tag>` deploys that ref's commit, building its image if
CI has not pushed it. A hand-run deploy skips the "production already runs a newer commit" check, so it can roll back.

### Shared Azure CI

Main-branch CI and Nightly use the `azure-ci` organization runners when `CI_RUNNER_LABELS` is set to
`["self-hosted","Linux","X64","azure-ci"]`. Delete the variable to return new jobs to GitHub-hosted runners.
PRs and non-main dispatches always use hosted runners; ARM64 image and publishing jobs remain on native ARM hosts.
The runner group independently restricts execution to the CI and Nightly workflow files on main. It grants access
only to run, camel-bots and camelAI. This trusts commits pushed to main; it does not enforce code review.

The pool on camel-devbox has four slots shared across the repositories, an aggregate limit of 8 vCPUs and 24 GiB,
and higher CPU scheduling weight than the continuously running DST jobs. It reserves no cores. Every test job uses
its own Postgres container and allocated port; Docker commands target the exact service container ID. Test shards
run two files at a time (`TEST_CONCURRENCY`). The nightly run uses two file workers.
Python dependencies live in a checkout-local virtual environment. Manual CI dispatch does not trigger deployment.
