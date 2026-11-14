# Workflow steps: snapshot the guest, replay only as a fallback

> **Superseded in part (Miguel, 2026-11-14): there are no jobs.** Agents compute through one `bash` tool backed by
> one VM per agent per branch; `job()`, `job_run` and the `computer` tool family are gone, and parallel work runs as
> child agents, each with its own `bash` VM. The current design is [camel-fs-compute.md](camel-fs-compute.md) §2
> and §6. What this document says about jobs is the record of the replaced design.

Follow-up to open question 1 of [swarm-workflows.md](swarm-workflows.md) and the replay measurement in #791. In that
design every workflow step starts a fresh QuickJS VM and replays the script from the top, answering journaled effects
from a table. One step costs O(effects so far), so a workflow whose events arrive one at a time costs O(n²) in all.
Measured in process: **33 s of CPU for 500 effects**, an estimated 46 min for 5,000 and 3 h for 10,000. This note
measures the alternative: keep the VM itself between steps.

## What was measured

`backends/workers/test/exchange-snapshot.ts` (test-only) is a minimal VM driver with pi-codemode's protocol: the stock
prelude, the `bridge` host function, the job drain and its interrupt polls, the deterministic clock and PRNG, and
`seq`-ordered results. On top of that it can `snapshot()` and `restore()`:
- **Snapshot:** quickjs-wasi's whole linear-memory image plus a small JSON header. The header carries the host-side
  state that lives outside Wasm memory: the clock, the PRNG state, the next `seq`, calls issued, `exportHandle` tokens
  for the prelude's `settle`/`stalled`/api, and the build fingerprint.
- **Restore:** a fresh instance of the same compiled module. `bridge` is re-registered by name and the handles are
  imported from their tokens.

Each step restores the previous snapshot (stored gzip level 1), delivers one result, runs until the script waits
again, snapshots and compresses. The workload is the replay harness's: N sequential `agent` effects, results as 20 KB
handles. Numbers are in process on Node 22, 4 vCPU exe.dev VM, 24 MiB heap; raw data in
`measurements/exchange-snapshot.json`.

| Effects | Script keeps | Whole workflow | Per step | Snapshot raw → gzip | Restore | Run | Snapshot | gzip / gunzip |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 8 chars per result | 1.0 s | 20 ms | 1,600 → 216 KiB | 3.7 ms | 0.8 ms | 1.8 ms | 9.3 / 2.8 ms |
| 500 | 8 chars per result | 8.1 s | 16 ms | 1,600 → 211 KiB | 3.6 ms | 0.3 ms | 1.0 ms | 7.9 / 2.6 ms |
| 5,000 | 8 chars per result | 97 s | 19 ms | 2,176 → 286 KiB | 3.5 ms | 0.6 ms | 4.2 ms | 10.1 / 3.7 ms |
| 50 | every handle | 0.9 s | 17 ms | 1,600 → 218 KiB | 6.4 ms | 0.2 ms | 1.4 ms | 8.3 / 2.6 ms |
| 500 | every handle | 9.1 s | 18 ms | 1,728 → 239 KiB | 3.7 ms | 0.6 ms | 1.4 ms | 8.9 / 2.9 ms |
| 5,000 | every handle | 142 s | 28 ms | 3,328 → 557 KiB | 4.4 ms | 1.1 ms | 2.7 ms | 19.8 / 20.3 ms |

Against replay with a journal table (#791, same machine):

| Effects | Replay: last step | Replay: whole workflow | Snapshot: whole workflow |
| ---: | ---: | ---: | ---: |
| 500 | 118 ms | 33 s (measured) | 8 s |
| 5,000 | 1.1 s | ~46 min (sum of measured steps) | 97–142 s |
| 10,000 | 2.2 s | ~3 h | ~4–5 min (extrapolated) |

A step costs about 17–28 ms whatever the journal holds, so a whole workflow is linear. Most of that is compressing a
mostly-zero image: the 1.6 MiB floor is the fresh VM. Brotli at quality 1 compressed a 2.1 MiB image in 5.5 ms against
gzip-1's 10.4 ms. Diffing dirty 64 KiB pages against the previous snapshot would cut both the time and the bytes; both
are optimizations left for later.

## What survives a restore, and what does not

The tests are in `test/exchange-snapshot.test.ts`.

- **Survives** (each checked):
  - pending promises, including a `Promise.all` over effects that is half answered, with results delivered in reverse
    and reordered by `seq`;
  - closures and the job queue;
  - `Math.random()` (QuickJS's PRNG lives in linear memory);
  - `Date.now()` (the virtual clock, from the header);
  - the prelude's pending-call map.

  A workflow restored on every step ends with exactly the value of one VM that never stopped.
- **Must be carried by the host, or the run silently diverges:**
  - the clock, the WASI PRNG state, `nextSeq`, `issued`;
  - the handle tokens. These are exported once, on the first snapshot: a restored VM keeps exported boxes forever, so
    exporting again each step would leak three a step.
- **Does not survive:**
  - host callbacks other than named ones (`bridge` is re-registered);
  - ephemeral functions (the prelude uses none);
  - anything a host closure held. pi-codemode's `startVm` keeps exactly such state in closures (`api`, `settle`,
    `stalled`, `clock`, `nextSeq`, `early`), which is why the prototype has its own driver.
- **The poll budget becomes a step's**, not the VM's lifetime's: a restored instance starts counting at zero. That is
  the right semantics for a workflow. A restored loop still stops at its budget (tested).
- **Memory only grows.** Wasm memory never shrinks, and freed QuickJS memory is not zeroed. A script that once used
  20 MiB stores a 20 MiB image (compressed, but less well) on every later step. Cap the stored size, and fall back to
  replay past the cap.

## Build fingerprint

A snapshot restores only into the identical build. The header names the quickjs-wasi version, the sha256 of the Wasm
module's bytes, the sha256 of the prelude, the driver version, the stack size and the heap limit. For example:
`quickjs-wasi 3.6.2, wasm d4c9375f2b1ca4dc, prelude 57c8dc8c0e812117, driver 1, stack 262144, heap 25165824`.
Any difference refuses the restore with `Snapshot from another build (...), not (...): replay from the journal instead`.

On Workers, Wrangler compiles the npm `quickjs.wasm` at build time and the bytes are not readable at runtime. The
build therefore stamps the hash as a constant (a build script, or the lockfile integrity of `quickjs-wasi` plus the
pi-codemode version).

## Storage

At 200–560 KiB per snapshot here, one snapshot per workflow overwrites a single DO SQLite row. SQLite-backed Durable
Objects cap a row or blob at 2 MB. A heavy script's image can exceed that (24 MiB raw at most; poorly compressed if the
script churned memory), so:
- store in 1 MiB chunks in one table (`snapshot(workflow, chunk, bytes)`) written in one transaction with the journal
  row that the step's new effect adds;
- past a cap (say 8 MiB compressed), keep no snapshot and replay that workflow from the journal.

R2 is not needed at these sizes, and it would make the step commit non-atomic. The bytes cross the sandbox RPC twice a
step (the restore image in, the new image out), well within Workers RPC limits.

## Alternatives

- **Bounded replay with checkpoints** (segment at `phase()` or every N effects; the script returns or `checkpoint()`s
  its state, and a step replays only its segment). It makes the cost O(segment), but it moves the burden to the
  author. Every value live across a checkpoint must be serializable and passed explicitly. Pending work
  (`Promise.all` across a boundary, closures) cannot cross it. Forgetting a variable is a silent divergence, not an
  error. This is Temporal's continue-as-new, with the same footguns. Not recommended unless snapshots fail.
- **Keep the VM warm in the sandbox DO between steps.** This is fastest, but the sandbox object is stateless,
  per-session and evictable, and it would still need the snapshot after eviction. It is a cache over option 1, not an
  alternative, and we avoid caches by default.
- **A V8 isolate instead of QuickJS.** It replays faster, but it still replays, and Workers offers no snapshot of a running isolate.
  It does not fix the O(n²) shape.

## Recommendation

**Snapshot at park, with replay as the fallback.**
1. The journal stays the source of truth.
2. When a step parks (every call it has out is pending), the sandbox returns the VM snapshot with the park. The
   workflow object stores it in the same transaction as the step's new journal rows.
3. The next event restores it and delivers only the new results.
4. On a missing, oversized or other-build snapshot, the step replays from the top with the journal table (#791's
   path, about 1 s at 5,000 effects). From then on it snapshots again, so a deploy costs each live workflow one replay.

## Risks and what it needs

- **pi-codemode support.** `startVm`/`serveCodemodeRemote` have no snapshot or restore. Either upstream hooks
  (`session.snapshot()`, `startVm({ restore })`, host state exposed), or our own driver as in this prototype. That
  means about 200 lines we keep in step with pi's prelude and protocol, and the prelude-hash fingerprint catches drift.
  **Upstream is the recommendation.**
- **Exchange protocol.** The step request carries `restore: { image }` and the park message carries `snapshot`, which
  makes it protocol 3. This uses #791's versioning: an older sandbox refuses it clearly, and the runner falls back to
  replay.
- **Silent divergence.** If a piece of host-side state is missed, restores still work but outcomes drift. Guard: in
  tests and on a sample in production, verify that a restored step makes the same next call as a replayed one.
- **Trust.** Snapshot bytes are guest memory. Only the runtime writes and reads them, never a tenant API, and they stay
  inside the Wasm sandbox if corrupted. Store them where tenants cannot write.
- **Cost.** About 20 ms of sandbox CPU and about 250 KiB written per step. That is a DO SQLite write of a few rows per
  step, against seconds of CPU per step for replay at thousands of effects.
- **Not yet measured on Cloudflare.** All timings are Node on this VM. Next, a deployed probe runs the same harness in
  the sandbox Worker.
