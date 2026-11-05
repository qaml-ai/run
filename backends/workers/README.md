# Workers-native camelRun experiment

An optimistic, independent Workers app, built from `codex/cf-hybrid`. No ECS
server is needed. No production service is changed. Read
[ELEGANCE.md](ELEGANCE.md) for measured size, compatibility results and the
limitations of this experiment.

The app uses real Postgres migrations, Pi Durable in an agent DO, an isolated
remote codemode worker, tenant admission DOs, volume DOs, R2, Images and Queues.
Its default configuration deliberately uses a deterministic local model and
local-only fixture credentials. It is not a deployable production configuration.

## Run locally

Node 22.21+ and Docker are required. From this directory:

```sh
npm ci
node scripts/local-postgres.mjs
npm run dev
```

Postgres is isolated in `camelrun-proto-workers-pg`, bound to localhost:55434.
The script applies the repository's migrations unchanged and seeds synthetic
credit. Hyperdrive's `localConnectionString` points only to that database.
Wrangler starts the API and codemode Workers together. Default API port: 8787.
The local operator token is the fixture value in `wrangler.jsonc`; it is not a
real credential. `POST /v1/agents` accepts `{"model":"test/echo"}`. Send
`{"text":"hello"}` to `/v1/agents/<id>/prompt`, then poll its request or open
`/clients/<id>/events`. `test/echo` also accepts `ask:Question`, `delegate:Task`
and `code:<JavaScript>` to exercise the actual tool and journal paths.

Do not run `wrangler deploy` with this fixture configuration. No deployment is
needed for any result in this directory.

## Validate

```sh
node scripts/reuse-sql.mjs --check
npm run typecheck
npm test
npm run test:integration
npm run build
python3 scripts/python-compat.py
npm run test:compat
npm run measure
node scripts/report.mjs
```

`build` only bundles with `--dry-run`. Tests use actual local workerd, SQLite,
R2 and Postgres. The integration command also exercises both Linux computer
providers through local Docker. Each API test fixture creates and drops its own
Postgres database. This matters: Hyperdrive local mode strips the connection
URL's startup `options`; a URL-level `search_path` did not isolate these
fixtures.

Compatibility results are in `measurements/compatibility.json`, with individual
TAP logs. The compatibility command exits nonzero while contract failures
remain. The adapter swaps the original tests' Node server fixture for Workers
and preserves their assertions and local fake-model responses. Tests that
instantiate Node services directly are marked not applicable, not passed. Python
uses the original module and replaces its subprocess launcher. Unit-only tests
are counted separately from tests that reach the Worker.

The source measurement script lists every input file and counts physical lines,
including comments and blank lines. It includes the generated, unchanged
financial logic; excludes dependencies, tests, docs and generated binding
declarations on both sides. These are implementation footprints, not
equivalent-feature savings.

## Cleanup

```sh
node scripts/local-postgres.mjs --stop
```

This removes only the named prototype Postgres container and its ephemeral data.
Test workerd processes, temporary directories and computer containers are
stopped by test cleanup. No Cloudflare resource, paid model call or snapshot is
created by this experiment. The earlier prototype's approximately $5 spend is
unchanged.
