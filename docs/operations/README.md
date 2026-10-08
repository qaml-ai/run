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
- [Billing](billing.md): prepaid credit, the ledger, storage metering, Stripe, which keys a tenant's calls use
- [Tenants](tenants.md): admin tenants and `infra/tenant.sh`: tokens, keys, agent and spend limits, other limits
- [Model endpoints](model-endpoints.md): a tenant's model calls through a pass-through gateway of the operator's
- [Account data](privacy.md): export, deletion, what is kept and for how long; handling requests by email
- [Account email](account-email.md): sign-up, password reset and adding a password by email; SES setup
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
