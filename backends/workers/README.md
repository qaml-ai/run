# Workers-native camelRun experiment

Experimental: an internal pilot, not a supported deployment or a replacement for
the ECS runtime. Nothing here runs in production; production keeps running the
Node runtime at the repository root.

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

Key measured results (hibernation, load stages, parity totals, test timings) are
summarized in [measurements/README.md](measurements/README.md).

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

`npm test` and `npm run test:integration` run through `scripts/run-tests.mjs`,
which runs test files side by side. Every file is isolated: its own Postgres
database, its own ports and its own Wrangler state directory. A database is a
copy of a template that holds the migrated schema; the template is built once
per migration set, so no test applies the migrations again. Unit files run one
per CPU (at most 8). An integration fixture is a Wrangler plus a workerd, so
those run two at a time, or more on a larger machine (one per 4 CPUs and
2 GB of memory: starving them fails tests that have real deadlines). Override with
`--concurrency=N`; any other option goes to `node --test`:

```sh
npm run test:integration -- --concurrency=2
npm test -- --test-shard=1/3          # a third of the files
```

To spread a suite over Sprites, let `scripts/sprite-test` start one command per
shard (the repository root's `scripts/sprite-test` leases the Sprites):

```sh
scripts/sprite-test --shards=4 HEAD bash -lc \
  'cd backends/workers && npm ci && WORKERS_REQUIRE_DOCKER=1 npm run test:integration -- --test-shard={shard}/{shards}'
```

### Docker on a sprite

The native computer test (`test/computers.integration.ts`) runs on Sprites as on
CI, `WORKERS_REQUIRE_DOCKER=1` included. `scripts/sprite-test` sets Docker up once
per sprite (`docker_up` there): Ubuntu's `docker.io` and `docker-buildx`, `dockerd`
as a `sprite-env` service (sprites have no systemd), `overlay2` on the sprite's own
`/var/lib/docker` volume, the default bridge kept, and the socket in the sprite
user's group. Three things differ from a stock host, all measured on 2026-11-06
(kernel 6.12.115-fly, Docker 29.1.3):

- **runc 1.1.15, not Ubuntu's 1.4.** workerd runs each container in its egress
  sidecar's network namespace. runc 1.2 and later open the new container's mount
  namespace from the host to set it up, which needs `CAP_SYS_PTRACE`, and a
  sprite's root lacks it: `error spawning mount remapping thread: ... open
  /proc/<pid>/ns/mnt: permission denied`. crun (camel-bots' choice) runs those
  but hangs any bridge container in `Created`; workerd's sidecar is one.
- **`runc start` waits for the container's process.** Until it starts, the
  container's init is runc's own and not dumpable, so an exec in that window
  fails (`failed to open /proc/<pid>/ns/ipc: Permission denied`). workerd execs
  at once, and then waits forever for an exec that never ran. A wrapper around
  runc returns from `start` once the container's process has started.
- **No `xt_socket`.** Cloudflare's egress sidecar (`cloudflare/proxy-everything`)
  adds `iptables -m socket -j DIVERT` and exits when the kernel refuses it. The
  test probes for that and, only then, runs the same pinned image with that one
  rule dropped (the TPROXY rule that follows finds established sockets itself),
  served from a throwaway local registry because Wrangler pulls the image before
  each start. On CI the probe passes and the image is Cloudflare's own.

Port publishing (`-p`, `-P`), outbound traffic from bridge containers, and image
builds (`RUN` steps included) work. Two things do not, both for want of
`CAP_SYS_PTRACE`: a bridge container whose image starts as non-root (`USER`,
`-u`) fails to start (`bind-mount /proc/<pid>/ns/net -> /var/run/docker/netns/...:
permission denied`; one that starts as root and drops privileges, like
Postgres, is fine), and `docker exec` into a container whose process is not
root fails (`error executing setns process`).

Some tests have a slow variant that runs only with `WORKERS_SLOW_TESTS=1`: the
"Workers tests" workflow runs them nightly, and on demand (Run workflow with
`slow: true`). Today that is queued account deletion, which the suite runs at
101 agents (5 deletion passes with the process killed between them) and the slow
run at 2001 agents (81 passes, about 8.5 minutes on a Sprite: 4.5 creating the
agents, 3.7 deleting them):

```sh
WORKERS_SLOW_TESTS=1 node --import ./test/compat-register.mjs \
  --experimental-strip-types --test test/account-deletion.integration.ts
```

Compatibility results are in `measurements/compatibility.json`; the individual
TAP logs are written next to it and not committed. The compatibility command exits nonzero while contract failures
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
