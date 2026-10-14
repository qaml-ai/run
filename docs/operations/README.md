# Operating the agent runtime

These pages are for people who run the agent runtime or work on its code: how it is built, configured,
deployed and billed, and what isolates tenants and generated code. To build on the hosted runtime, start
with the [Quickstart](../quickstart.md) and [Concepts](../concepts.md) instead.

## Runbooks

What to do, for the hosted runtime (AWS account `904534089871`, us-west-2):

| Runbook | Use it when |
|---|---|
| [Deploys and infrastructure changes](deploys.md) | following or debugging a deploy, deploying or rolling back by hand, shipping a settings change, applying Terraform (and reading its plan) |
| [Migrations](migrations.md) | adding a migration, a migration-number clash in `tests/db.test.ts`, renumbering one that is not applied |
| [Alarms](alarms.md) | an alarm fired: what each one watches, its threshold and topic, what to check first |
| [Logs and metrics](logs-and-metrics.md) | answering a question from the logs or metrics: Logs Insights queries, counting log events, which models are slow or failing |
| [Model operations](models.md) | adding or rotating a platform key, the Azure OpenAI deployments and models, a slow or failing model |
| [Tenants](tenants.md) | `infra/tenant.sh`: making a tenant, tokens and keys, agent and spend limits, credentials for a product |
| [Billing](billing.md) | credit, the ledger, Stripe, a payment that needs review (`-billing-review`) |
| [Account email](account-email.md) | sign-up and password mail, SES setup, bounces and complaints |
| [Email channels](email-channels.md) | turning email channels on (`email_domain`, two steps), reply modes and forwarders, why a message did not arrive |
| [Fetched tool credentials](tool-credentials.md) | a tenant's `auth: exchange` tool server fails |
| [Managed Discord](managed-discord.md) | the shared Camel Discord application, onboarding, its secrets |
| [Account data](privacy.md) | an export or deletion request |
| [Model attempt reconciliation](model-reconciliation.md) | usage of interrupted model calls, unsettled attempts |
| [Admin analytics](admin-analytics.md) | the admin site's product signals, run pages and user journeys, and what they need deployed |
| [`infra/README.md`](../../infra/README.md), [`infra/terraform/README.md`](../../infra/terraform/README.md) | what the AWS resources are, the scripts, how a rollout drains tasks |

## Reference

- [Architecture](architecture.md): control and data planes, ownership, logs, draining, deploys, turn handoff
- [Release notes](release-notes.md): rollout requirements and incompatible changes; [unreleased/](unreleased/) holds
  a file per change on main since the last tag
- [Configuration](configuration.md): environment variables, starting a runtime
- [Self-hosting](self-host.md): the image, Docker Compose, storage, networking
- [Persistence](persistence.md): transcripts, history chunks, journals, retries, idle unload, limits per node and tenant
- [Model endpoints](model-endpoints.md): a tenant's model calls through a pass-through gateway of the operator's
- [Tenant isolation](isolation.md)
- [Sandbox](sandbox.md): the codemode sandbox's layers and limits
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

### Shared Azure CI

Main-branch CI and Nightly use the `azure-ci` organization runners when `CI_RUNNER_LABELS` is set to
`["self-hosted","Linux","X64","azure-ci"]`. Delete the variable to return new jobs to GitHub-hosted runners.
PRs and non-main dispatches always use hosted runners; ARM64 image and publishing jobs remain on native ARM hosts.
The runner group independently restricts execution to the CI and Nightly workflow files on main. It grants access
only to run, camel-bots and camelAI. This trusts commits pushed to main; it does not enforce code review.

The pool on camel-devbox has four slots shared across the repositories, an aggregate limit of 8 vCPUs and 24 GiB,
and higher CPU scheduling weight than the continuously running DST jobs. It reserves no cores. Every test job uses
its own Postgres container and allocated port; Docker commands target the exact service container ID. Test shards
run two files at a time on Azure (`TEST_CONCURRENCY`), one on hosted runners. The nightly run uses two file workers.
Python dependencies live in a checkout-local virtual environment. Manual CI dispatch does not trigger deployment.
