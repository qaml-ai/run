# Workers-native camelRun experiment

Experimental: an internal pilot, not a supported deployment or a replacement for
the ECS runtime. Nothing here runs in production; production keeps running the
Node runtime at the repository root.

An optimistic, independent Workers app, built from `codex/cf-hybrid`. No ECS
server is needed. No production service is changed. Read
[ELEGANCE.md](ELEGANCE.md) for measured size, compatibility results and the
limitations of this experiment.

The app uses real Postgres migrations, Pi Durable in an agent DO, an isolated
remote codemode worker, tenant admission DOs, repo DOs, R2, Images and Queues.
Its default configuration deliberately uses a deterministic local model and
local-only fixture credentials. It is not a deployable production configuration.

Workers files use `/v1/repos`. Agent mounts use `{ repo, path, mode }`, image saves
use `{ repo, path }`, and apply takes repo IDs in mounts. Requests to
`/v1/volumes` and its subpaths return 410. The internal Volume binding still
serves snapshots for the old job paths. Pilot Volume data is test data and
will not be migrated when that binding is removed.

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

## Computers

The optional native computer (`computer` tool, `src/computers/objects.ts`) is a
`ContainerComputer` Durable Object per agent that owns one container through
`ctx.container`, under Cloudflare Containers' `durable_object` scheduling
policy; the legacy `Container` class and the Sandbox SDK are not used. An agent
has one only when its definition declares `computer` (`{}` for the default) or it
was given one as a sub-agent (`hasComputer`, `src/core/computer-share.ts`): the
binding alone gives no agent the tool. Its code
picks the image (`COMPUTER_IMAGE`: a name in the Wrangler `images` map, built
from `computers/Dockerfile` and pinned by digest at deploy; default `workspace`)
and the size (`COMPUTER_INSTANCE`: `lite`, `standard-1` to `standard-4`;
default `lite`) at every start. The container has no Internet and stops after
60 s idle. Commands are `exec` with bounded output. Reading, writing and parsing
files run small Node programs in the image (file content travels over the exec's
stdin and stdout), so the image needs only Node.

Container time is metered (`src/computers/meter.ts`): each call's setup names
its payer (the identity's tenant and agent), and each container session, from
start until destroyed or idled out (its idle timeout after the last use), is
charged as platform usage (`kind: "computer"`, model `cloudflare/<instance>`)
at cost: provisioned memory and disk for its time, plus the CPU-seconds the
container's cgroup counted (`cpu.stat`, read after each operation and before
each stop; unread time, such as the idle tail, at the provisioned vCPU);
a session in constant use is charged every 5 minutes. Every operation is
refused once a prepaid tenant's credit is spent or an agent spend limit is
reached. Sessions wait in DO storage until their charge commits; the DO alarm
settles idled-out sessions and retries failed charges.

Snapshots are Cloudflare filesystem snapshots (`snapshotContainer`, restored by
`start({ containerSnapshot })`). The DO keeps each as a handle in its storage:
`{ id, name, size, image, createdAt, expiresAt }`, where `image` is the digest
the filesystem came from and `expiresAt` is 30 days after creation or the latest
restore made here. Restoring a handle from another image digest, or past
`expiresAt`, is refused before anything starts. The handle is plain data, so any
computer DO can start from another's (`takeSnapshot`, `snapshotHandle`,
`startFromSnapshot` RPCs).

A container's disk lasts only while it runs, so a computer keeps a **base**: the
snapshot its next start restores instead of the image. `sleep` snapshots the
disk as the base before it stops the container; a restore makes the restored
snapshot the base; a fork's child gets the parent's snapshot as its base. An
idle stop loses what changed since the base, and the operation that starts the
container again says what it restored (`computer: { restoredFrom, note }`), or
that a base it could not use (expired, or from an older image) was dropped
(`resumed: false`). Booting from the base also keeps snapshots small:
Cloudflare stores only what changed since the snapshot a container was
restored from.

**Fork** (`src/computers/native-fork.ts`): the parent's computer answers
`forkSnapshot(batch)` with one snapshot per batch (one delegate or spawn_agent
call's children share it), of its running container or else its base;
`seed(snapshot, origin)` makes it a child's base, and the child `adopt`s it at
the parent. A child's `release("purge")` (its work done) or deletion `unref`s
it; the last child takes the batch's entry with it, and one no child adopted is
dropped after ten minutes. `release("sleep")` saves a child's disk and stops it.

Every start is bounded: a start or restore that does not run its first command
in 12 s is destroyed and tried once more (3 of about 60 restores in the
benchmark took 22–63 s; a new placement usually comes up at once), then the
operation answers `COMPUTER_STARTING` ("still starting, call again") and the
next call waits for that container instead of booting another. A start the
account's limits refuse fails at once with `monitor()`'s reason.

Deleting an agent calls `purge()` (after its session is aborted), which stops
its container, charges its time and drops its handles. The snapshots
themselves stay on Cloudflare until their 30-day expiry: **there is no Worker
API to list or delete a snapshot**, so a deleted agent's computer files can
outlive it by up to 30 days. A snapshot this runtime no longer uses is logged as
`computer_snapshot_unused` (with its id) and recorded under `dropped:<id>` in
its computer's storage; its `rootfs-snapshot-*` registry tag can be deleted by
hand. A snapshot restored from another (a child's own sleep) may depend on it,
so delete tags of whole fork trees. Snapshots are tags in the application's
image repository; deleting that repository deletes them.

`wrangler.computers.test.jsonc` binds the computer for
`test/computers.integration.ts` (Docker required) and the pilot binds it too
(`PILOT.md`). `wrangler.jsonc` and `wrangler.test.jsonc` leave it out, so
`npm run dev` and the other suites build no container image.
`node probes/computers/remote.mjs` deploys a throwaway probe on Cloudflare,
measures start, snapshot and restore into three DOs, and deletes everything
(`PLATFORM.md`, "Live experiments").

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
per sprite (`docker_up` in `scripts/sprite-test-core.sh`): Ubuntu's `docker.io` and `docker-buildx`, `dockerd`
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

### Client-held voice calls

The `VoiceCall` Durable Object owns each call and its alarms. OpenAI audio goes directly between the client and OpenAI. The object holds the outbound sideband WebSocket while the call is live. Workers have no node-retirement cut. If the sideband closes, the object ends the call through the provider.

ElevenLabs uses a workspace webhook to settle the completed call. If that report is absent, the object reads the provider conversation and settles at the post-call deadline.
