# Platform parity experiment

This branch adds Workers-native platform services. It is a draft integration
candidate, not full parity or a production deployment. Channels and voice
sessions are excluded. Standalone speech and transcription are included.

## Implemented and exercised

| Surface | Implementation and evidence |
| --- | --- |
| Files and projects | R2 multipart uploads; volume DO write ordering, CAS, snapshots, labels, pins and two-pass GC; keyed volumes; archives; source `publishTool`; signed downloads/uploads; mounts, persistent presented-file outputs and durable stale-write guards. Four unchanged project tests and two unchanged file HTTP tests pass. |
| Computers | Public creation, agent computer tools, inherited settings, lifecycle cleanup; Lambda API SigV4 via aws4fetch; Sprites, Tunnel and Daytona REST; E2B SDK; optional Container and Sandbox SDK providers. Fake endpoints only for external providers; local Docker and one real Cloudflare Container lifecycle verified. Three of seven unchanged computer API cases pass. |
| Media | Source image generation/editing, transcription and standalone speech providers and validation, streamed PCM/WAV, volume image output, usage and end-user holds. Provider/policy copies have a drift check. Local fake-provider integration passes. Existing R2 image transport is retained for the separate streaming-image track. |
| Schedules | Source calendar and repeat policy; DO alarm wake-up; durable SQL email intents; Queue repair; verified/suppressed recipient rules; delivery leases, receipts and bounded retries. No real email sent. |
| Admin/service | Ten read admin endpoints reuse source SQL behind an explicit account allowlist. Account-only `/registry` list/detail/request bridge rejects browser Origins. |
| Transport | Hibernatable WebSockets on existing events URLs. TypeScript and Python negotiate with Accept, use a same-origin authenticated socket when offered, and select SSE explicitly against Node. Restricted browser tokens retain filtered SSE. WebSocket errors do not silently downgrade. |
| Observability | Source safe-error classification, structured metrics and credit-refusal logs; Analytics Engine points for turns, media, model cost, source run events and webhooks. Fourteen source alarm policies have tested thresholds and explicit missing-signal states. |

Optional Azure settings use `AGENT_AZURE_OPENAI_ENDPOINT`,
`AGENT_AZURE_OPENAI_API_KEY`, `AGENT_AZURE_IMAGE_DEPLOYMENT`,
`AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT` and `AGENT_AZURE_OPENAI_API_VERSION`.
Empty deployment strings disable Azure for that kind. These paths were tested
against fake Azure and OpenAI endpoints only.

The SDK implementation is in `clients/`; the packages in `sdk/` export it.
Current Node SDK/watch tests and selected Python SDK tests pass without changing
the Node runtime. Browser negotiation uses the CORS-safelisted Accept header.
The bearer credential is in the WebSocket subprotocol, not its URL.

## Live experiments

`measurements/platform-files-cloud.json` records a run of the actual Volume class
and upload implementation on Cloudflare. Concurrent CAS had one winner and one
conflict. A pin kept overwritten bytes through GC; after unpinning, two-pass GC
removed them. A 6,291,463-byte multipart upload retained its SHA-256 and took
2,262 ms. The temporary Worker, namespace, objects and bucket were deleted and
their absence independently checked.

`measurements/platform-container-cloud.json` records a real Cloudflare Container
using the existing `ContainerComputer` and Dockerfile. Node execution and a
write/read of a synthetic file passed; startup through the first command took
7,090 ms. This was one `lite` instance (1/16 vCPU, 256 MiB memory, 2 GB disk).
The Worker, DO namespace, container application and image were deleted; final
inventories were empty and the deleted application returned 404. The bounded
probe is reproducible with `node probes/computers/remote.mjs`.

`spikes/hibernation/` deploys the actual CamelAgent without Postgres or model
bindings. `measurements/platform-hibernation.jsonl` records an idle socket kept
open for 180 seconds while the DO instance changed. That establishes eviction
and socket survival. In the paired run the WebSocket recorded 0.018834176 GB-s
(0.147142 active seconds) while SSE recorded 23.10440768 GB-s (180.503185 active
seconds). The WebSocket had no duration records in the two interior idle
periods, while SSE kept accruing duration. Both connections remained open for
180 seconds; only the WebSocket object changed instance.

`platform-hibernation-duration-final.json` contains the delayed Cloudflare
period metrics; `platform-hibernation-summary.json` contains their sums.
Earlier empty analytics results are retained as evidence of ingestion delay,
not interpreted as zero. The Worker and namespace were deleted and the final
inventory is empty in `platform-hibernation-cleanup.json`. Cloudflare bills
duration while active or unable to hibernate, and does not bill eligible idle
objects; see its [pricing documentation](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Only `camelrun-proto-*` resources are used. No real AWS account, model-provider
credentials or production database was used. Marginal cloud spend is estimated
below $0.01 for the file run and below $0.01 for the transport run; these are
estimates, not invoice measurements. The Container probe adds less than $0.05
estimated marginal cost. Its full provisioned-resource upper bound over
55.124 seconds is $0.000111 before Worker/DO, registry and network charges,
using Cloudflare's [published Container rates](https://developers.cloudflare.com/containers/platform/pricing/).
All platform probes together are conservatively estimated below $0.10.
No temporary cloud resources remain.

## Remaining parity and integration gates

- Files: prompt attachment hydration depends on the agent/image track. Mount
  notifications, the `/computer` filesystem bridge, storage quotas and isolated
  regular-expression grep remain absent. Regex grep returns an explicit 501.
  Snapshot metadata is bounded at 16 MiB; forks copy independently owned bytes.
- Computers: managed Lambda creation is test-only until metering, holds and
  settlement join the money track. Native Modal requires its HTTP/2 client;
  Workers supports it only through a configured provider gateway. Four original
  cases still stop at missing agent request/tool-result features. No claim is
  made about real AWS or provider execution.
- Media: all four original image API/SDK cases and the standalone transcription
  case pass. The remaining transcription contracts require agent attachment
  hydration or stateless runs. Media shares encrypted provider keys, key-scope
  gateways, admission, prices and transactional usage with the money track.
  Azure platform image/transcription routing uses source validation and transient
  fallback; speech and tenant/admin/scoped credentials retain their source
  routing. Provider URLs require the configured media/Azure origin or an
  operator allowlist. No live provider execution was attempted.
- Schedules: code schedules depend on the agent track's `execute` request.
  Accepted email with a lost response remains at-least-once; a lease and delivery
  ID prevent ordinary concurrent sends, not that external ambiguity.
- Admin/service: admin UI, Access/session authentication, report-email writes,
  full inspector metadata and ECS-only health checks are not implemented.
- Alarms: the catalog is an evaluator, not a deployed alert service. Turns,
  webhook age, model spend and per-tenant model spend are wired; the other ten
  rules explicitly report insufficient instrumentation. No Analytics Engine query
  scheduler, external health probe
  or notification destination has been installed. Existing RDS alarms remain
  external infrastructure concerns.

These are migration gates, not requests to enable production. The next design
decisions are the managed-computer metering/recovery integration, a Modal
gateway versus a different provider, the `/computer` mount bridge, and the alert
query/delivery service. See `src/alarm-policy.ts` for exact source thresholds and
gaps.

## Verification

The test fixtures create and migrate isolated local Postgres databases. The
original assertion bodies are unchanged; `test/compat-runtime.ts` replaces only
their server fixture and maps synthetic tenant/provider settings.

The original 146-case inventory moved from 50 pass / 57 fail / 39 N/A to
58 pass / 53 fail / 35 N/A: three computer and four image cases now pass; four
standalone transcription cases are attempted instead of excluded, with the
standalone HTTP case passing. Expanding the inventory with file/project cases
adds six passes, three failures and seven Node-only N/A cases: 162 total,
64 pass / 56 fail / 42 N/A. Nineteen passes reach workerd; the other 45 are
SDK unit tests. The original assertion bodies are unchanged.
The complete assertions and first failures are in `measurements/compatibility.json`
and adjacent TAP files. New focused tests prove additional behavior without
relabeling failing original contracts.

The final combined Workers unit suite passes 238/238 and the integration suite
passes 62/62 (225.0 seconds), including source money policy. Eight drift checks,
typechecks, dry-run bundles and documentation checks pass. Current Node
transport/SDK/watch tests pass 26/26; selected Python SDK tests against Node pass
5/5. Python transport tests pass 4/4.
`measurements/platform-validation.json` and adjacent TAP files retain results.

Commands used:

```sh
npm run typecheck
npm test
npm run test:integration
npm run test:compat
node scripts/reuse-media.mjs --check
node scripts/reuse-schedules.mjs --check
node scripts/reuse-computers.mjs --check
node scripts/reuse-admin.mjs --check
node scripts/reuse-volume-policy.mjs --check
node scripts/reuse-money.mjs --check
npm run build
```

Also run from the repository root: TypeScript event-transport tests, Python
event-transport tests, current Node SDK/watch tests, selected Python SDK tests,
and the SDK TypeScript typecheck. The compatibility command deliberately exits
nonzero while the recorded parity failures remain.
