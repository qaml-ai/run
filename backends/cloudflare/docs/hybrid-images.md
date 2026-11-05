# Image storage and memory study

Measured November 5, 2026. This spike changes no ECS code. Source is in
`spikes/images/`; raw local and Cloudflare observations are in
`hybrid-images-local*.json` and `hybrid-images-cloud.json`.
For comparison only, the prior text-history experiment in `FEASIBILITY.md`
measured 61.27 MiB for 10,000 1-KiB messages, and 174.39 MiB plus isolate
replacement for 50,000. Those are separate workloads, not image baselines.

## What camelRun stores today

There are two paths, not one universal base64 transcript:

| Path | Durable history | Model request |
| --- | --- | --- |
| Attached volume file / native file tool | `FileRef`: path, volume, version, size, contentType, immutable chunk IDs, inspected media dimensions. No inline original. | `agent-host.ts:hydrate` reads chunks, scales when needed, and substitutes an image block. |
| Direct inline image / custom tool image | Pi `ImageContent {type:"image", data:string, mimeType:string}`; `data` is base64. | Pi's provider adapters produce Anthropic base64 sources or OpenAI/OpenRouter data URLs. |

`src/files.ts:FileRef`, `src/inspect.ts:fileRef`, and `src/agent-host.ts:fileData`
establish the reference path. File chunks are pinned to the agent so removing a
volume file does not break earlier history. An R2 object alone is not equivalent:
the replacement needs this retention/ownership invariant, content hashes,
authorization, and erasure across forks and exports.

`src/inspect.ts:fitImage` performs header/container checks in the host, then
decodes oversized images in an isolated parser process. `src/inspect-worker.ts`
uses sharp with one libvips thread, no operation cache, deterministic scaling,
EXIF rotation, and no retained metadata. JPEG stays JPEG; other formats use PNG,
then JPEG-on-white if necessary. The limits are 1,568 pixels on the longest side
and 3.75 MiB encoded (5 MiB base64), with a 32 MiB input and 64-megapixel decode
cap. The separate process, deadline, RSS ceiling and seccomp boundary matter;
moving sharp into a DO is not an equivalent implementation.

Commit `7e53b5b4` added request-time scaling so old large images would stop
breaking long threads. Commit `af5a48d3` keeps transient failures retryable.
Current code also scales inline images before new journal writes, but preserves
the original when that attempt fails transiently; old history is fitted when
read for a request. Referenced originals remain in blob storage and the host
caches fitted base64. The hydration cache is bounded at 32 MiB. One request's
image budget is 20 MiB base64, newest first, at most 40 images or 90 for Anthropic;
older images become placeholders. Budgeting the outgoing request does not by
itself bound Pi's already-loaded inline history.

The Cloudflare prototype does not currently implement that ECS hydration policy.
Its installed Pi 1.5.0 `types.d.ts:ImageContent` has no URL or reference member.
The journal's `entry.model` embeds the message. `root.context()` reconstructs
those embedded messages. Its OpenAI completion/Responses adapters explicitly
construct `data:<mime>;base64,<data>`; accepting a URL at the provider API does
not make stock Pi send a URL. This spike's `image_ref` is an experimental stored
block, materialized explicitly by the spike, not a production Pi extension.

## Experiment

The fixture consists of 100 indexed, deterministic PNGs, each 1,600 × 1,200,
4,205,813–4,211,856 bytes (about 4.01 MiB). It has a title bar, sidebar and dense
grayscale noise. This stresses poorly compressible screenshots; it is not a
representative corpus or an OCR-quality test. The v1 seed expression pairs
adjacent seeds, so there are 51 distinct byte contents, stored at 100 distinct
keys. This reduces content diversity and may permit backend deduplication; the
measured footprint must not be generalized to 100 distinct photographs. The
generator retains this mapping to reproduce the recorded experiment. No user
data is uploaded.

Every case loads the actual `CamelAgent` and its PiHarness/SQLite adapter, using
the deterministic provider but making no model call. The inline case appends
stock image blocks to real Pi entries. The reference cases append compact
experimental reference blocks, then either transform the original stream at
request time or save and reuse the transformed derivative in R2.

The local harness restarts workerd for each case and reads CDP
`Runtime.getHeapUsage`. These are JS heap snapshots with transient allocations,
not absolute production memory. Local workerd is demonstrably willing to exceed
the cloud's limit. Cloud measurements hold the live context/payload for 30
seconds and read matched-object periodic isolate metrics. Those metrics cover
the whole isolate, including co-located objects, and can miss peaks.

The request-materialization cases deliberately include all N images, without
the ECS outgoing-byte budget, to expose the failure mode. A production adapter
must apply the budget before reading older image objects and cap concurrent
transforms. URL payloads use non-resolving placeholder URLs: this measures the
DO allocation shape, not successful provider access or signed URL integration.

Local results, MiB (`2^20` bytes):

| Design / images | Loaded-history JS heap | After materializing request, JS heap | Backing storage / embedder heap at request sample | Result |
| --- | ---: | ---: | ---: | --- |
| Empty Pi agent | 15.84 | — | 1.01 / 0.37 | Baseline, not subtracted from other samples |
| (a) Inline / 20 | 336.66 | Same retained history | 1.01 / 0.37 | Local process exceeds cloud capacity; cloud append/load resets |
| (a) Inline / 100 | Unavailable | Unavailable | Unavailable | Local transport/inspector failed; next status had a new constructor and no loaded context |
| (b) R2 refs, streamed transform, base64 / 20 | 16.81 | 69.18 | 2.94 / 5.16 | 23.34 MB serialized body; all 20 images |
| (b) R2 refs, streamed transform, base64 / 100 | 17.22 | 237.94 | 2.91 / 0.56 | 116.69 MB serialized body; no request budget applied |
| (c) Cached derivative + URL payload / 20 | 16.81 | 27.44 | 15.95 / 5.29 | 2,244-byte serialized body; reuse JS 27.50 MiB |
| (c) Cached derivative + URL payload / 100 | 17.22 | 25.65 | 31.03 / 3.32 | 11,204-byte serialized body; reuse JS 25.84 MiB |

These are sampled categories, not a peak profiler or forced-GC measurement.
In particular, the cached path's backing storage contains unreclaimed transient
derivative buffers, so quoting only its JS heap as total isolate memory would
be wrong. The 100-image cache-population run reused 20 derivatives created by
the preceding case and transformed 80; it was partially warm. Its subsequent
100-image request transformed zero. The cached-plus-base64 fallback was not
measured; it would still pay outgoing base64 and serialization memory, unlike
the URL path.

Local (b) took 0.90 / 4.26 seconds for 20 / 100 transforms. Corrected local (c)
took 1.09 seconds for 20 cold transforms and 4.16 seconds for the partially warm
100-image case; reuse took 6 / 25 ms on the Worker. These are local simulator
times, not production service latency. The first cached implementation failed
with `Provided readable stream must have a known length`; that raw failure is
retained in `hybrid-images-local-first.json`, not counted as a successful case.

Cloud observations from `hybrid-images-metrics.json`:

| Design / images | Maximum matched-isolate sample | Memory-error counter sum | Verified outcome |
| --- | ---: | ---: | --- |
| Empty Pi agent | 19.02 MiB | 0 | Stable during hold |
| (a) Inline / 20 | 272.26 MiB | 1 | Stock append/context load returned an explicit memory-limit reset |
| (a) Inline / 100 | 285.97 MiB | 4 | Stock append/context load and diagnostic materialization reset |
| (b) Reference + streamed transform + base64 / 20 | 76.53 MiB | 0 | All 20 serialized; same constructor during following hold |
| (b) Reference + streamed transform + base64 / 100 | 272.32 MiB | 2 | HTTP 200 returned, but the next hold had a new constructor and no context/payload |

The large samples describe over-limit execution, not supported extra capacity.
They include setup/transient allocation and are not the memory of one image or
a safe per-agent budget. Object filtering identifies the case while the metric
still measures its entire isolate; other objects can be co-located. Counter sums
are telemetry observations, not a count of unique user-visible failures. The
raw file preserves each sampling minute and request/hold window.

The first cached cloud version's cold 20-image transform completed in 19.971
seconds and held a 2,244-byte URL payload. Its following metadata-only cache
read stalled, and its 100-image case also timed out. The corrected fresh-Worker
retry completed request, hold, reuse and status for 20 and 100 images without a
constructor change. Both retries were fully warm. The original 20-image cold
case had a maximum 34.10 MiB matched-isolate sample and zero memory-error
counter observations; its broken reuse path prevents treating it as a complete
cache implementation. The original 100-image case's 35.37 MiB sample held no
hydrated payload and is not a valid 100-image request-memory result.

The corrected 20 / 100-image cloud runs retained 20 / 100 references and URL
payloads of 2,244 / 11,204 bytes through request, 30-second hold and reuse.
Reuse took 1.461 / 7.279 seconds. Their five bounded telemetry polls and the
final post-cleanup read returned no rows, so corrected cloud isolate memory
remains **unverified**, not zero. The local corrected-path samples above provide
the measured memory comparison for both counts. Cloud request success is
evidence of this bounded run, not a proof of peak memory or production capacity.

## Local versus actual Images

The [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
works in ordinary `wrangler dev` through a low-fidelity offline implementation.
Its documented offline subset is width, height, rotate and format. It is useful
for plumbing and memory tests; it does not validate production resize policy,
JPEG quality, animation handling or pixel equivalence. The high-fidelity service
needs remote execution/bindings and the Cloudflare account. Local binding use
does not incur usage charges. This run also exercises the actual deployed
binding with R2 streams, rather than treating the offline implementation as a
service benchmark.

`IMAGES.input(original.body).transform(...).output(...).response().body` avoids
`original.arrayBuffer()`. A direct output-stream `R2.put` failed locally because the Images response did
not expose a known-length stream. The corrected cache writer bounds and buffers
only one derivative (at most 3.75 MiB), then writes it to R2; the full original
is never buffered. This boundary must also be honored in the production design.
The reference-plus-base64 path still holds derivative strings and the serialized
provider body. Streaming the input alone cannot eliminate those allocations.
The first deployed cached implementation then exposed a second error: using
`R2.get` only for metadata left bodies unread and the warm path stalled. The
corrected URL path uses `R2.head`; when bytes are needed, its body is consumed.
Cloud retry results are separated in `hybrid-images-cache-retry.json` and use
a fresh Worker/DO namespace to avoid mixing a deployment with retained state.
Both corrected retry cases were fully warm on their first measured request:
`transformed: 0`. Their cache-hit timings do not establish cold population
cost. The first retry's initial `prepare` received 401 while the new secret
propagated; subsequent calls were authenticated successfully. The failed call
did no DO work. Its authorized `seed` opened the default test PiHarness/root
directly, without adding the optional configuration row (4 KiB smaller database
than the configured 20-image case). This is a benchmark-fixture limitation,
not evidence of an authentication bypass. The 100-image retry prepared normally.
The runner now retries that initial propagation response before proceeding.

## Provider URL support

Checked against primary documentation November 5. No live provider vision call
is claimed in this study.

| Provider | Documented URL input | Implication |
| --- | --- | --- |
| Anthropic direct API | `image.source = {type:"url",url}`; Files API `file_id` is another option. Bedrock/Google-managed transports have different restrictions. | Add a direct-API adapter branch; do not assume every Claude transport accepts URLs. [Vision](https://platform.claude.com/docs/en/build-with-claude/vision) |
| OpenAI | Chat Completions `image_url.url`; Responses `input_image.image_url`; file IDs also supported. | A URL avoids base64 in the DO request but images still consume tokens. [Images and vision](https://developers.openai.com/api/docs/guides/images-vision) |
| OpenRouter | Vision chat content has `image_url.url` with a public URL or base64 data URL; model must support image input. | Route-specific provider limits remain; stock Pi currently emits a data URL. [Image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding) |
| Workers AI | Model-dependent. The Llama 3.2 vision tutorial documents `image` as base64 or a URL. Other model schemas describe bytes or data URIs; a generic `image_url` field is not proof of arbitrary HTTPS fetch support. | Select and test each model/transport; keep bounded base64 fallback. [Llama vision tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/), [model schema](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/) |

Use immutable content-hashed derivative keys and short-lived, tenant-scoped
capability URLs. Providers fetch separately; the URL must remain valid through
fetch/retry, while ordinary callers must not gain read access. Do not put signed
capabilities into long-lived history or logs. Keeping one stable URL path while
authorizing its query can affect provider prompt-cache identity; measure this
before advertising caching parity. URL support does not remove provider image
count, pixel, token or request limits.

## Cost and recommendation

Current [Images pricing](https://developers.cloudflare.com/images/pricing/) is
$0.50 per 1,000 **unique monthly transformations**, or $0.0005 each after the
first 5,000 included transformations. This includes the binding: since
[July 1, 2026](https://developers.cloudflare.com/changelog/post/2026-07-01-binding-unique-transformations/),
repeated source/parameter combinations in a calendar month count once. Reusing
the same transformation is not billed once per turn. Format/quality differences
do not create additional unique billable transformations under the documented
rule. Uncached calls still decode and encode again; saved derivatives reduce
latency and compute even when transformation billing would be unchanged.

R2 adds $0.015/GB-month storage, $4.50/million Class A writes and $0.36/million
Class B reads, before included allowances. For this approximately 0.421 GB
original corpus, a full month is about $0.00631 before allowance; derivative
storage is additional. One hundred unique transforms are $0.05 marginal before
allowance. Worker/DO requests, active duration, SQL I/O, and model tokens remain
separate costs. These rates are from [R2 pricing](https://developers.cloudflare.com/r2/pricing/);
this study's exact bounded operations and cleanup are recorded in the raw file,
not an invoice or a claim that all account activity belongs to this run.

Recommend (c): immutable original and versioned deterministic derivative in R2,
small references in durable Pi history, URL input for verified transports, and
a bounded derivative-base64 fallback. Generate/repair a derivative outside the
agent's resident context when possible. Retain the existing newest-first byte
and image-count policy and window/compact text history. Store inspection
results and permanent failures; retry transient transform failures. A provider
payload must not re-expand every retained image just because the original
stream is external.

The corrected cloud cache-hit path still performs one sequential `R2.head` per
image: measured server reuse was 1.461 seconds for 20 and 7.279 seconds for 100.
That is avoidable per-turn I/O, not a recommended final implementation. Persist
the validated derivative's content hash, version, size and dimensions with its
reference; construct URLs without rechecking every object on each turn, and
repair a missing derivative on demand. That optimization is proposed, not
measured here.

The same change benefits ECS for direct inline/custom-tool images and avoids
repeated derivative generation after host eviction. Existing attachment paths
already have chunk references and a fitted-image cache, so describing this as
an entirely new benefit from Workers would overstate the case. A backend-neutral
image-reference contract can be developed and tested before deciding hosting.

## Reproduction

From `backends/cloudflare`:

```sh
npm ci
node spikes/images/local.mjs
WRANGLER_LOG_PATH=spikes/images/.wrangler/logs \
  npx wrangler deploy --dry-run -c spikes/images/wrangler.jsonc \
  --outdir spikes/images/dist
node spikes/images/remote.mjs
# Optional paired correction run while remote.mjs still owns the fixture bucket:
node spikes/images/cache-retry.mjs
```

The primary remote runner requires the configured Cloudflare credential. It checks the
exact resource names are unused, creates only `camelrun-proto-hybrid-images`,
sets a random bearer through stdin (kept only in process memory), uploads synthetic
fixtures, measures, and removes its R2 objects, DO class, Worker and bucket.
It refuses pre-existing resources with that exact name. No account settings,
DNS, other prototype resources, production databases, or snapshots are touched.
The correction runner owns `camelrun-proto-hybrid-images-retry` and its namespace;
it reads the main run's fixtures and derivative cache, then removes its own
resources. Run it before the main runner reaches teardown. Its first cache
request can be partially or wholly warm; the `transformed` count is the source
of truth, and the repeated request must report zero transforms.

Each runner acquires its own exclusive local lock and creates a unique temporary
state directory. Run only one primary experiment per account at a time, including
from other hosts: the cloud names are fixed and a local lock cannot coordinate
machines. Only the explicitly paired retry may share the primary fixture bucket.
Preflight rejects pre-existing exact names without adopting or deleting them.
Cleanup attempts are independent, and nonempty final inventories fail the run.

## Verification and cleanup

`node --check` passed for every spike `.mjs` file. The isolated check
`./node_modules/.bin/tsc -p spikes/images/tsconfig.json` passed. Wrangler dry-run
bundled the Worker successfully; this does not substitute for the TypeScript
check. Local and remote runners completed, with the expected inline-memory
failures preserved as observations. The first cache failures, retry and
secret-propagation 401 remain in the raw files rather than being overwritten.

The primary teardown deleted 200 R2 objects, its bucket, DO class and Worker.
The paired correction deleted its own DO class and Worker. The final read-only
audit at `2026-11-05T12:04:21.202Z` found no exact-name Worker, namespace or bucket,
both endpoints returned 404, no local/remote measurement runners remained, and
no `camelrun-image-study-*` temporary directory remained. Evidence is in
`hybrid-images-cleanup.json`; the earlier retry teardown's 410 was deletion
propagation, resolved by the final audit. No credentials or user images are
retained. Account billing totals and a real provider fetching a signed R2 URL
remain unverified.
