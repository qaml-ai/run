# Hybrid source estimate

Source baseline: `7d991fe26676` (the #635 prototype base). Counts are physical
TypeScript lines, including comments and blank lines, with no dependencies,
generated code, tests, Rust/C, infra or documentation counted. These are estimates
of a completed **agent-host cutover**, not changes made by this study. Keeping ECS
agents active during a phased rollout adds the new backend before deleting anything.

Run `node backends/cloudflare/spikes/design/code-estimate.mjs` from the repository
root to verify source counts and recompute the arithmetic. The JSON beside it
records every input and assumed removal range. Each file is counted once; ranges
for `node.ts` and `client-sessions.ts` include their parking, routing and lifecycle
code, so those are not counted again as separate modules.

| Source module | Current lines | Lines retired, estimate | Why / what remains |
| --- | ---: | ---: | --- |
| `src/ownership.ts` | 495 | 80–150 | Agent claims and routing leave; volume/channel/voice ownership remains. |
| `src/node.ts` | 1,811 | 400–650 | Agent startup, routing, orphan scans and retirement wiring shrink; control-plane services remain. |
| `src/node-config.ts` | 211 | 30–60 | Remove agent-host capacity and retirement settings only. |
| `src/supervisor.ts` | 500 | 350–500 | Process handles, admission, watchdog and storage RPC leave; export helpers need relocation. |
| `src/agent-child.ts` | 42 | 42–42 | No per-agent Node child entrypoint. |
| `src/rpc.ts` | 102 | 50–102 | Agent IPC leaves; shared Rpc consumers need porting before whole-file deletion. |
| `src/client-sessions.ts` | 2,845 | 650–1,050 | Remove host capacity, lease, orphan, handoff and local lifecycle paths; request semantics remain. |
| `src/agent-host.ts` | 1,370 | 250–450 | Drop host-specific boot/IPC and replace with PiHarness; model/tool policy remains. |
| `src/v8-exec.ts` | 156 | 156–156 | Replace process pool/prespawn/launch with separate sandbox Worker. |
| `src/codemode-pi-launcher.ts` | 175 | 175–175 | Replace V8 frame bridge and process admission with remote codemode adapter. |
| `src/sandbox.ts` | 83 | 0–0 | Confined is also the parser security boundary: preserve unless parser is independently replaced. |
| `src/sandbox-wire.ts` | 49 | 0–0 | Parser framing remains; not exclusively v8-exec. |
| `src/memory-retirement.ts` | 49 | 0–49 | Agent pressure logic can leave; retain while control-plane fleet still uses it. |
| `src/process-memory.ts` | 16 | 0–16 | Same conditional removal as node memory guard. |
| `src/ecs.ts` | 185 | 0–80 | Agent-specific protection/retirement shrinks; service addressing and metrics may remain. |
| `src/history-pages.ts` | 304 | 120–220 | Replace PG ordinal access and legacy fill; preserve bounded paging contract. |
| `src/pi-durable/storage.ts` | 1,621 | 900–1,300 | Agent PG adapter/storage RPC becomes DO storage; hooks and compatibility need replacement. |
| `src/pi-durable/ordinals.ts` | 331 | 40–100 | Remove PG lazy-fill plumbing; ordinal/cursor contract remains. |
| `src/pi-durable/reclaim.ts` | 154 | 80–120 | No distributed agent PG journal sweep; keep retention behavior. |
| `src/pi-durable/host-journal.ts` | 263 | 50–100 | Host bridges shrink; host message and run completion semantics remain. |
| `src/scheduler.ts` | 216 | 60–100 | PG polling and claims become an alarm multiplexer; recurrence/retry logic remains. |
| `src/busy-agents.ts` | 107 | 0–25 | Tenant-wide admission remains; replace runtime-node liveness with durable permits. |
| `src/log-tail.ts` | 157 | 30–60 | Agent hot tails leave; shared-volume compaction remains. |
| `src/storage-gc.ts` | 115 | 0–0 | R2 still needs reachability/liveness for shared immutable chunks. |
| `src/gc-verify.ts` | 94 | 0–0 | Integrity and erasure verification still needed. |
| `src/pin-backfill.ts` | 86 | 0–0 | Historical retention/import tooling remains during migration. |

The 11,537-line selected surface loses an estimated **3,463–5,505 lines**.
The existing prototype is **1,062 lines** across `src/` and `codemode/`.
Neither Pi nor Cloudflare package internals are counted as our source, but moving
code to a dependency transfers maintenance risk; it does not eliminate it.

| Newly written beyond the existing prototype | Estimated lines |
| --- | ---: |
| Hyperdrive billing bridge, usage outbox, dedupe and reconciliation | 600–1,000 |
| Bounded history, image-reference adapter, cache lifecycle | 500–900 |
| Directory routing, migration export/import, generation fencing | 450–800 |
| Policy/tool adapters, alarm multiplexer and external-effect state machines | 600–1,200 |
| Observability, integrity and erasure adapters | 150–300 |

That adds **3,362–5,262 lines including the prototype**, for an estimated net
**2,143 lines fewer to 1,799 lines more**. A central arithmetic scenario is about
172 fewer lines; it is not a point prediction. The defensible benefit is removing
agent ownership/host coordination from our operating model, not promising a large
code-count reduction. All ranges are engineering judgment based on responsibilities
read in the listed files, not measurements of an implemented migration. Tests and
migration utilities add further code and are excluded on both sides.

## Where the simplification stops

- **Leases and routing:** `Ownership` also fences shared volume writes, channel
  connections and voice sessions. Agent address discovery and heartbeats leave
  the agent path; the module and `runtime_nodes`/`actor_owners` cannot disappear
  wholesale while those services remain. The retained Node control plane needs
  a smaller fleet, not zero fleet operations.
- **Parking and memory:** `ClientSessions.makeRoom`, `resumeOrphans`, `handOff*`,
  `releaseIdle`, `tick`, `unload`, the supervisor and ECS retirement wiring lose
  their role for DO agents. A DO still needs bounded context, durable continuation
  and quiet waits. A live Promise, SSE stream or remote human-input wait may keep
  it billed; automatic idle eviction is not an application-level parking protocol.
- **History:** `history-pages.ts` already reads bounded ordinal ranges and refuses
  oversized reads. Its API semantics, stable cursors, byte limits, fork cuts,
  retention and export remain necessary. The prototype's full-materialization
  implementation is a regression to fix before migration, not a deletion saving.
- **Scheduler:** the PG poll/claim loop becomes one alarm per agent that multiplexes
  user schedules, continuation, outbox retry and expiry. Calendar/DST rules,
  occurrence IDs, cancellation, retry ceilings and email delivery remain ours.
- **Code execution:** `v8-exec.ts` and `codemode-pi-launcher.ts` can leave the agent
  backend after remote-codemode parity, but the remote sandbox still needs quotas,
  cancellation, output bounds and independent-isolate failure tests. `sandbox.ts`
  also confines image/document parsing today; that security behavior is not free.
- **GC and pins:** R2 stores objects, but does not determine whether agent histories,
  shared volumes and snapshots still refer to them. Retain PG reachability and
  grace periods. Newly introduced image variants need versioned keys, expiry and
  deletion receipts too. Replacing the shared-volume design is separate work.
- **Postgres:** keep account, billing, OAuth, usage, webhook and administration code.
  Hyperdrive is a transaction pool, not a drop-in substitute for session-level
  advisory locks, `LISTEN/NOTIFY`, or a Node `pg.Pool` held indefinitely.

## New behavior to implement, not just new adapters

Use a Postgres agent directory with backend and generation, fencing every
provision/revoke/migrate mutation. An agent DO owns its canonical journal, prompt
queue and local outbox. It must explicitly serialize mutating operations across
external awaits: a single JavaScript thread does not make a whole asynchronous
handler atomic. Put short local transitions in SQLite transactions; do not hold
`blockConcurrencyWhile` or a PG transaction across a model/tool request.

Credits remain a PG authority. Admit a bounded model call using a durable PG
reservation, then run the provider outside the transaction. Commit the canonical
model entry and usage outbox together in SQLite. Apply the receipt and charge
atomically in PG using a stable receipt ID, and acknowledge only after PG commits.
Crash/retry tests must cover every boundary. A hold's expiry is not evidence that
an external call did not happen; reconcile the uncertain outcome before releasing
it. The detailed transaction audit and local spike define the narrower pieces
that are actually verified.
