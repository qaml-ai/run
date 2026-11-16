# Roadmap: camelRun on camel-fs

The plan for getting from today's two backends to the target architecture, and what is simpler once we are there.
Last updated 2026-11-16. Per-limitation status lives in the ledger
([camel-fs-v0-limitations.md](camel-fs-v0-limitations.md)); this doc is the order of work and the reasons.

## Target

- **camelRun** keeps agents and money: turns, tools, workflows, billing and credits, on the Workers backend
  (`backends/workers`). The Node backend (`backends/node`, production today) is retired once nothing needs it.
- **camel-fs** (`camelfsd/`, one Go service on AWS plus Firecracker hosts) keeps repos, refs, files and VMs.
  Refs are in DynamoDB, objects in S3. Hosts enroll with mTLS and boot agent VMs that mount a ref.
- **camel-bots** keeps Discord audio and its own UI; the platform keeps only the agent side of voice.

## Rules for the work

- One owned path per job: no fallbacks, no second implementation kept "just in case".
- Every v0 shortcut is a ledger row; a fix closes its row with measured numbers.
- No caches, TTLs or proactive limits by default. Measure first.
- Schema and key changes are expand/contract: two deploys.
- Small, verified PRs into `camelfs/files-model`. The production cutover follows the readiness checks below.

## Tracks

### 1. The tier serves (done)

The camel-fs tier is deployed and the Workers pilot uses it for refs, files and VMs.

- Open: L89, the ref write latency. After #1204 the tier measured 69.6 ms p50 in-region, down from 80.6 ms.
  The Worker measured 89 ms p50 from Portland. The tier's ≤50 ms p50 target remains open.

### 2. Refs in DynamoDB, RepoDO deleted (mostly done)

Decided 2026-11-13 (option C): one AWS service holds refs in DynamoDB; the per-repo Durable Object goes.

- Done: refs routes on the tier, lineage deletion with durable retries (#1197, L129), deletion stamps (#1204).
- Next: delete any remaining DO repo code; convert `tests/camelfs-refs-tier.ts` from the `aws` CLI to direct
  DynamoDB Local requests (the CLI costs 3–11 s per call on sprites, see #1204).

### 3. VMs in camel-fs (live on one host)

Agent VMs run on Firecracker hosts managed by the tier (`/v1/vms`, host enrollment, usage).

- Done: launcher, host enrollment, usage, first-session apply pipeline (#1200, L120): first-ever apply of
  50 MB 8.0→4.2 s, 500 MB ~12→7.2 s, 2 GB 28→15.5 s.
- Done on the pilot: Firecracker Bash, committed workspace reads and checkpoint recovery (#1208, #1211).
  The legacy Cloudflare container class and application are retired (#1210, #1212).
- Shared workspace disk replicas are removed (#1209). Git commits hold the durable workspace.
  Hosts keep local image caches for warm starts. Cold starts reconstruct committed files. The paired
  benchmarks and the cold-start cost are recorded in L133.
- The pilot's `bash` tool boots and reuses one VM per agent branch, fences it with the ref lease, and
  checkpoints before returning success. The idle VM shuts down and its usage settles through durable
  receipts. File tools operate on committed workspace versions without booting a VM.
- Next: L132, the 2 GB bound. The host→guest vsock carries ~200 MB/s, then guest disk writes (~230 MB/s), then
  S3 head-of-line (3.3 s). Measure raw vsock throughput first; then bigger frames and buffers, or build the
  first tree into the image on the host.
- Next: L131, small files. ~10k small blobs cost ~3.4 s of S3 GET latency at 128 in flight. Fix by packing small
  blobs into fewer objects; a storage-format change, so design first.
- Later: ublk for the block layer, measured before adopting.

### 4. Voice split

The platform keeps the agent side of voice (provider sessions, the ask-agent tool path, billing); audio, Discord,
`say` and the jukebox live in camel-bots. Turn detection is the provider's.

- Done: voice calls core, OpenAI sideband, ElevenLabs calls, SDK call shape, client-held calls on Workers.
- Next: the camel-bots voice v2 canary behind `VOICE_V2`.
- Later: a `voice` field on the agent so `POST /v1/voice/sessions {agent}` is all a client needs; a browser
  example and SDK helper for the WebRTC and signed-URL handshakes; check provider SIP support for phone agents.

### 5. Per-turn Postgres

The Node backend ran ~215 Postgres queries per turn. Cut it to tens, then compare cost at real traffic.

- Done: many fixes (settlement, webhooks, receipts, limits, the computer hint: 71→50 statements, 17→7 connects).
- Next: the remaining fixes and the account-deletion 503 flake.

### 6. Harness health

CI and sprites must stay trustworthy.

- Next: the SIGSEGV seen only on the sprite kernel (no production exposure: 0 matches in 7 days of logs); the
  abort-lifecycle 120 s timeout; moving sprite run directories to local disk; sprite disk drops (nbd0
  read-only remounts) and the out-of-rotation `rt-pool-2`.

## After v0: what gets simpler

Ordered by payoff.

1. **Retire the Node backend** once camel-bots runs on Workers. Removes the copy generators, the drift gate,
   dual-backend contract tests and every feature built twice. Before retiring it:
   - voice has a home (item 4 above);
   - per-turn SQL is down to tens of queries;
   - no in-memory pending state in Durable Objects, startup under 30 s for any history, memory qualified for big
     contexts;
   - observability parity (the missing alarms, 5xx and health alarms, a fault-injection harness);
   - migration by fenced generation cutover: new agents first, camel-bots last, never both live.
2. **One lifetime rule: reachable from a ref.** Snapshots, pins, labels, read-set claims and the GC scripts go;
   one collector walks reachability from refs.
3. **No second copies of files.** Temp snapshots, staged arguments, copied attachments and per-volume exports
   become links to blobs or commits.
4. **No import or sync layer.** Jobs and VMs mount a ref directly.
5. **One storage number**: a counter on the repo, reconciled with S3 Inventory, with the quota check inside the
   ref CAS.
6. **Search on the daemon**: grep over the tree on camel-fs, no caps; a trigram index later.
7. **Fewer round trips on every write**: one daemon call and one ref call (target 150–200 ms for a job result,
   from 945 ms).
8. **Keep QuickJS for small scripts** (decided): it starts in milliseconds and needs no VM. `bash` is for real
    compute and files.

What stays: Postgres for money (billing and admission stay transactional and audited), and the files API for
clients, with batched reads and edge caching by hash.

## Order

1. Close the open measurements and rows above (L89, L131, L132), then the remaining Postgres and harness items.
2. Finish the camel-bots voice v2 canary on Workers.
3. Move camel-bots to Workers.
4. Retire the Node backend.

Items 2–7 fall out along the way.
