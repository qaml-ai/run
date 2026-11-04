# Cloudflare execution backend for camelRun

An alternative Workers/Durable Objects backend, developed independently of the
ECS implementation. This package has its own dependencies, lockfile, runtime,
and Wrangler configuration. It does not import the Node supervisor or its
Postgres storage adapter. The public TypeScript SDK is used unchanged in the
integration tests.

This is an experimental implementation of the core agent contract, not a
production replacement for every camelRun service. No deployment is required
for its local integration tests.

## Architecture

```text
Existing camelRun TypeScript SDK
  -> Worker: /v1 management and /clients execution APIs
      -> AgentDirectory Durable Object
           stable IDs, creation keys, configuration, revocation
      -> CamelAgent Durable Object (one per public agent ID)
           PiHarness + Lifecycle
           Pi journal, submissions and checkpoints in SQLite
           camelRun request records and event projection
           Computer private filesystem in the same SQLite database
              -> isolated Dynamic Worker JavaScript
                 no outbound network or provider credentials
           stock codemode -> separate Worker / sandbox DO (QuickJS)
           optional computer tool -> Container DO or Sandbox SDK + R2
           model provider
              production: Workers AI
              tests: explicit deterministic in-process provider
```

The directory and agent objects have separate responsibilities. The directory
owns lookup and authorization metadata. The agent owns its execution and files.
No ECS heartbeats, leases, owner discovery, or subprocess supervisor runs here.
Cloudflare's Lifecycle/PiHarness integration owns the recovery wake-up mechanism.

The prototype has one operator tenant. `API_TOKEN` is an operator secret;
agent credentials are scoped to one agent. A real multi-tenant account service
and budget authority remain separate work.

## Local development

From the repository root:

```sh
cd backends/cloudflare
npm ci
npm run typecheck
npm test
npm run test:integration
npm run test:computers  # optional: requires Docker, downloads public images
npm run build
```

`build` dry-run bundles both the agent and separate codemode Worker; it does not publish.
The test runner resolves the unchanged parent SDK dependencies from this package.
`test:integration` launches real local workerd processes with isolated temporary
state and kills/restarts them during a generation. It imports the repository SDK
rather than a special Cloudflare client.
The test model is explicitly enabled by test configuration; it does not call
Workers AI or another paid provider.

For interactive development, create an ignored `.dev.vars` with an `API_TOKEN`
of at least 32 characters, then use `npm run dev`. Do not put real production
secrets in test configuration. Workers AI calls can use remote resources even
when Wrangler runs locally. The test suite uses a deterministic provider instead.

The production Wrangler configuration disables workers.dev and preview URLs.
Real deployment requires explicitly configured routing and secrets. Nothing in
the tests deploys a Worker or changes the ECS service.

## Compatibility scope

The implementation targets keyed agent provisioning and credentials, configuration,
prompt submission and request lookup, state and event streams, abort, history,
revocation, and private Computer files/execution. Tests define the verified subset;
unsupported inputs must be rejected rather than silently ignored.
Configuration changes currently go through keyed upsert; direct SDK configuration
requests are refused to prevent divergence between directory and runtime state.
Numeric TTLs are also refused: use `Agents.upsert`, or explicitly durable creation
with an idempotency key / `ttlSeconds: null`. Automatic expiry is not implemented.

The HTTP transport projects Pi operations into camelRun request records. Pi's
conversation IDs and native event schema are implementation details. This is a
separate hosting backend, not another value of Node's `AGENT_ENGINE` setting.

File and code execution remain private to one agent. This backend does not yet
implement camelRun shared volumes, mounts, or the full `js_exec` tool
namespace/remote capability bridge. The optional Linux providers support explicit filesystem snapshots/backups; see
[the feasibility report](docs/FEASIBILITY.md) for lifecycle and persistence limits.
Isolated JavaScript has no network access,
bounded CPU/wall time/output, and does not replay automatically after interruption.
Those per-execution limits are not an account spending limit.

Run usage and tool/file summary accounting are not implemented. The backend omits
those summaries; SDK convenience objects may normalize absent values to empty
arrays or null. Do not interpret them as proof that no tools ran or no tokens were
used. Read conversation history for the underlying messages. Inline full-history
prompt results are unsupported; use the dedicated history endpoint.

The SDK event transport currently uses SSE. Idle open streams can keep an object
awake and billed; use lazy SDK connections and measure this before comparing
costs. Durable Objects remove node coordination, not every application-level
recovery or billing problem.

## Remaining production work

- Multi-tenant accounts, provider credential scopes, rotation and revocation.
- Durable usage receipts committed with canonical model entries, idempotent
  delivery to billing, account budget reservations and concurrent spend controls.
- Attached client tools, remote MCP/OpenAPI tools, approvals and full human-input lifecycle,
  delegation, scheduled work, channels, and stateless run compatibility.
- Shared volumes and artifacts, bounded large-history paging/export/import/forks,
  retention and complete erasure, and backend migration/rollback.
- Full provider support and model option parity, including structured output and
  all current camelRun run limits.
- Production observability, error taxonomy, cloud load tests, version migrations,
  deploy-mid-turn recovery, and live provider tests.

An unmodified client successfully exercising the tested routes does not imply
that every SDK method or option is supported. In particular, accounts, billing,
channel delivery and attached tool execution are not provided by PiHarness.

## How both backends fit camelRun

```text
camelRun control plane / API
  -> agent directory: tenant, public ID, backend, locator, generation
      -> ECS adapter        -> current supervisor and host
      -> Cloudflare adapter -> Worker and agent Durable Object
```

Initially, deploy this package separately and select it through the SDK base URL.
A unified deployment can later route each agent according to its backend. Keep
backend choice operator-controlled and fixed for an agent's lifetime unless an
explicit migration transfers ownership.

Extract shared contracts gradually around execution, history, files, and directory
lookup. Do not mirror every `ClientSessions` method in one broad interface or add
Cloudflare branches throughout `src/node.ts`. Reuse public protocol types and
pure validation/policy code where they fit; replace infrastructure-specific code.

For an existing-agent migration, quiesce and fence the source, verify an exported
state against the imported target, then switch the directory generation. A simple
routing change while both backends can run effects is not a safe migration.

## Verified in this worktree

- Typecheck, 10 unit tests, 14 local agent integration tests (including parent),
  3 local Docker computer tests (including parent), and Wrangler dry-run builds.
- SDK creation/auth, prompts/history/streaming, file tools, abort and restart.
- Stock remote codemode with nested tools, five hostile/failing scripts, human
  pause through a hard restart, deterministic replay and disabled-tool enforcement.
- Both Linux providers: exec/files, blocked Internet, snapshot/backup, destroy and
  restore, including the model -> codemode -> computer tool path.
- Local heap samples with 1, 8 and 16 additional agents; local computer timings.

See [FEASIBILITY.md](docs/FEASIBILITY.md) for measurements, caveats and feature gaps,
including the disposable November 4 Cloudflare deployment: real Workers AI
streaming, deploy/replay recovery, 100 concurrent deterministic agents, remote
codemode and Linux/R2 measurements. Those cloud tests do not establish arbitrary
external-effect recovery, Python SDK parity or production load/cost.
Request retention is unbounded. State reads scan retained requests, and history
reads materialize the transcript before slicing. Revocation exists; full physical
purge of Pi, Computer and backup data does not.

## Optional Linux computers

The default config omits the computer bindings. The `computer` tool returns an
explicit unavailable error without them. `wrangler.computers.test.jsonc` enables
both providers and a local R2 bucket. `npm run test:computers` starts this config
and the separate codemode Worker with local Docker, then cleans up its processes
and temporary state. It never allocates cloud resources.

Paths are relative to the Linux `/workspace`, separate from the normal private
Workspace. Use the `computer` tool with `provider: "container"` or `"sandbox"`
and `op: "exec" | "read" | "write" | "snapshot" | "restore" | "sleep"`.
Snapshot names select durable handles. Save explicitly before sleep; restoring
files does not resume running processes. Only the SDK backup gateway can reach
its scoped local R2 object; arbitrary Internet traffic stays blocked.

## Upstream

Pinned independently from the ECS package: Agents 0.33.0, Pi Durable/AI/Chord/Codemode
1.5.0, Computer 0.9.0, Sandbox 1.0.3 and Wrangler 4.157.0. See
[UPGRADE.md](docs/UPGRADE.md) for the API changes. PiHarness is beta. Computer's filesystem and JavaScript backend
are stable; its Linux container and some recovery features remain experimental.

- [PiHarness lifecycle and limitations](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Pi tool registration and replay semantics](https://developers.cloudflare.com/agents/harnesses/pi/extensions/)
- [Computer component status](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
