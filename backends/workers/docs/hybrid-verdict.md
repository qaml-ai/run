# Hybrid study verdict (archived)

Section 5 of the November 2026 hybrid study of the earlier Cloudflare prototype
(`backends/cloudflare`, since removed from the tree). This backend
([../README.md](../README.md)) is that study's follow-up experiment: an
internal pilot, not a supported deployment. The full study, its measurements
and spikes stay readable at the
[archived revision](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/cloudflare/docs/HYBRID.md); section numbers and file names below
refer to it.

## Verdict, effort and migration gates

| Area | What gets simpler | What gets harder / recommendation |
| --- | --- | --- |
| Agent ownership | Addressing, single-object storage, wakeup and recovery replace agent node registry/lease handoff. | Async handlers can interleave across external awaits. Explicit local state transitions and external attempt identities remain necessary. |
| Accounts and billing | Reuse Postgres locks, unique constraints and financial settlement; avoid D1 balance/ledger rewrite. | Journal and money no longer commit together. Durable outbox/inbox, reservations, reconciliation and generation checks are required. |
| Long histories and images | Small SQLite records and R2 objects can keep resident history small. | 128 MB is an isolate cap, shared with possible sibling objects. A full transcript/provider body can still exceed it; bounded history, derivative cache and URL transport are prerequisite work. |
| Schedules and parking | Alarms replace agent polling/claim loops; inactive agents need no resident process. | One alarm must multiplex recovery, schedules, expiry and retry. Alarms are at least once; open SSE/remote waits can keep duration billed. |
| Files and other services | Private small files naturally follow an agent. | Shared-volume GC/pins, voice, provider computers and channel state remain separate authorities. ECS does not vanish from this conservative hybrid. |
| Operations and cost | Less agent fleet capacity planning and no per-agent Node child. | More cross-platform traces, regional SQL latency, connection admission, platform quotas and per-operation costs. Compare matched workloads, not cloud headline prices. |
| Existing agents | Explicit backend selection permits a small new-agent cohort and reversibility. | Migrating live journals, queued work, tools, images, credentials, files and cursors needs fencing and reconciliation. A route flip alone can double-run effects. |
| Self-hosting | PG and portable protocol/data contracts remain reusable. | Cloudflare-specific storage, alarms, Images, sandbox and networking need replacements and independent failure/security qualification. |

### Phased person-day estimate

This is an engineering estimate, not measured delivery time. The same feature
rows as FEASIBILITY are compared so the apparent saving is not caused by dropping
features. Shared volumes, provider integrations and voice are retained on the
control plane; any full Workers port of those services is additional work in
**both** columns. Existing Pi prototype work is not counted again.

| Remaining parity work | Hybrid | Full port from FEASIBILITY |
| --- | ---: | ---: |
| Bounded journal/history | 3–5 | 3–5 |
| Fork/import primitives | 3–6 | 3–6 |
| Credits and billing holds | 4–7 | 8–15 |
| Tenants and API keys | 2–4 | 5–8 |
| Durable usage receipts | 4–7 | 4–7 |
| Scheduled wakes | 3–5 | 3–5 |
| MCP and tools | 6–10 | 6–10 |
| File volumes | 7–12 | 7–12 |
| Human input and quiet waits | 3–6 | 3–6 |
| Long streams | 4–8 | 4–8 |
| Many-agent scale | 6–12 | 6–12 |
| **Comparable feature subtotal** | **45–82** | **52–94** |

Group the hybrid work into reviewable stages: **9–16 days** for bounded state,
image adapters and PG identity/billing bridge; **30–54 days** for remaining
journal, tools, files, schedules and transport parity; **6–12 days** for the
feature table's concurrency/load qualification. These stages sum to 45–82;
some work can overlap across engineers. Retaining the present financial schema
saves an estimated **7–12 days**, not the whole billing row: the new atomicity
boundary still has to be implemented and tested.

Add **5–10 days** for existing-agent inventory, export/import checks and a
repeatable fenced cutover/rollback; **5–10 days** for independent security and
fault review; and **3–5 days** for an opt-in pilot and rollback rehearsal. This
makes a broader planning range **58–107 person-days hybrid**, versus **65–119
full port** using the same additional allowance. Real fleet volume, unsupported
legacy history, platform bugs and unavailable provider idempotency can increase
it. The source's 52–94 table itself excludes migration/review/rollout and says
rows overlap; neither range is a calendar commitment.

### Cutover and rollback protocol

1. Inventory each agent's version, history bytes, images, pending runs/inputs,
   tool identities, shared-volume references and unaccounted financial attempts.
   Reject unsupported states explicitly; do not migrate every agent by default.
2. Mark its PG directory `migrating` at a new generation. Fence old ECS dispatch,
   stop acceptance, drain or mark uncertain external attempts, and take a stable
   export cursor with checksums. Hold the old data and its pins.
3. Import into an inactive target DO under the new generation. Compare journal
   counts, cursors, payload hashes, pending requests, file reachability and usage
   totals. Imported historical entries must never emit new billable receipts.
4. CAS the directory to Workers only after import is verified. Start target work
   using the new generation. Stale requests and delayed old-generation external
   writes fail; already-incurred old usage has a separate reconciliation path.
5. Before any new target effects, rollback can reactivate the fenced original
   under a fresh, monotonically increasing generation; never reuse an old fence.
   After target progress, freeze/export/verify in the opposite direction before
   switching back. Never run both generations, and never refund an uncertain
   provider call merely because a transport timed out.

### Self-hosting evidence

`workerd` is open source and useful for local execution, but its own README says
it is not a hardened sandbox on its own; a secure surrounding execution boundary
is needed for untrusted code. It does not supply a managed distributed fleet by
itself. [workerd source](https://github.com/cloudflare/workerd).

`celld` offers distributed SQLite-backed Durable Objects and R2-compatible
storage on a fleet backed by an owned bucket. Its compatibility page, checked November 5, 2026,
lists **Hyperdrive and Workers AI as unsupported**, Node compatibility as
partial, and Containers as experimental. Images is not among its supported
service bindings. A celld target would need a tested direct-PG connection layer,
an image-transform service, model-provider adapters and compatible sandbox/RPC
behavior. Its own node, bucket, ownership, failover and upgrade operations remain
our responsibility. This study did not install or benchmark celld; compatibility
claims are documentation evidence, not proof that camelRun runs unchanged.
[celld overview](https://celld.dev/docs/),
[celld compatibility](https://celld.dev/docs/cloudflare-compat/).

### What must be verified before a production recommendation

- A real, isolated Hyperdrive origin benchmark: regional placement, saturation,
  database failover, lost COMMIT answers, private connectivity and provider-egress
  charges. Keep production databases outside the experiment.
- Full native model-attempt and end-user settlement, revision/late receipts,
  account deletion and billing-period boundaries under crashes. Prove that the
  tracked-attempt and untracked-receipt paths cannot charge the same usage twice.
- A bounded Pi image-reference/provider adapter on live supported models, pixel
  quality, URL authorization/expiry, restart/cache eviction and erasure. The
  current spike's URL payload shape does not prove provider fetch success.
- Mutation ordering, partition/restart behavior, long SSE or hibernating socket
  sessions, migrations and rollback with realistic histories and tools. Earlier
  500-way provider capacity errors remain relevant; no new result erases them.
- A matched-workload end-to-end cost comparison including the retained PG/control
  plane, Images, R2, DO SQL, sandbox duration, provider use and operations.

The evidence favors **hybrid over a full D1/DO port if we pursue Workers**, and
favors **keeping the current runtime while these gates are unresolved**. The
low-risk reusable first step is bounded image/history representation; it also
benefits ECS and does not commit the business to a hosting migration.

### Verification scope

The study's checks (prototype unit and workerd integration tests, the image and
Hyperdrive spikes, table-map and code-estimate scripts, docs build) ran against
the prototype tree and are listed in the
[archived report](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/cloudflare/docs/HYBRID.md). They validated the prototype and its
evidence, not ECS production or provider end-to-end behavior.
