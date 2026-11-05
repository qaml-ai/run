# Streaming image requests through unmodified Pi

Experiment in `qaml-ai/run`, November 5, 2026. It extends the investigation in
draft #645. It changes no ECS runtime, production configuration, database or
vendored Pi package. The measured implementation is commit `55a94bf9`.

The isolated package pins the published `pi-ai`, `pi-durable`, `pi-codemode`
and `chord` packages at 1.5.0, matching the existing Workers experiment. This
is separate from the application's vendored `1.5.0-main.f9a263655681` build.
The package lock and installed adapter source, rather than current upstream
main, are the basis of this report. No upstream issue or PR was opened.

## Result

The marker approach works without changing Pi. All three alternatives passed at 1, 20 and 100 images, both singly and across 50 concurrent agent workflows. The inline baseline failed at 20 images during requests and at 100 while seeding. Every completed receiver check matched the expected image hashes.

Use **B, in-DO streaming**, as the base64 HTTP path: it is simpler than a proxy and passed the full matrix. Prefer **D, signed URLs**, for explicitly verified URL-capable provider/model combinations; it used less agent CPU and had the best large-image latency here. Keep **C** for a deliberate isolation or centralized-egress requirement. It reduced agent DO work but added a service and did not improve the 50-agent/100-image latency materially. None of these results establish production readiness; integration gaps are listed below.

<!-- COMPARISON -->
### Single agents

DO metrics include seed, request, hold and status work. CPU is seconds; memory is MiB.

| Variant | Images | Result | DO isolate max* | DO CPU* | Request seconds | Memory-error observations* |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| A | 1 | Hashes match | 42.57 | 0.245 | 0.038 | 0 |
| A | 20 | Request OOM | 367.63 | 3.829 | — | 3 |
| A | 100 | Seed OOM | 266.54 | 6.759 | — | 1 |
| B | 1 | Hashes match | 21.92 | 0.386 | 0.259 | 0 |
| B | 20 | Hashes match | 40.14 | 7.745 | 17.175 | 0 |
| B | 100 | Hashes match | 55.29 | 27.883 | 69.562 | 0 |
| C | 1 | Hashes match | 11.74 | 0.113 | 0.305 | 0 |
| C | 20 | Hashes match | 13.26 | 0.061 | 28.953 | 0 |
| C | 100 | Hashes match | 14.57 | 0.234 | 130.532 | 0 |
| D | 1 | Hashes match | 11.74 | 0.048 | 0.482 | 0 |
| D | 20 | Hashes match | 13.77 | 0.072 | 5.102 | 0 |
| D | 100 | Hashes match | 14.83 | 0.239 | 34.606 | 0 |

### Fifty concurrent agent workflows

Successful-request p50/p95 are seconds. Every successful group has 50 latency samples; failed groups have none.

| Variant | Images each | Hash matches | DO isolate max* | DO CPU total* | Request p50 / p95 | Memory-error observations* |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| A | 1 | 50/50 | 266.74 | 9.560 | 0.024 / 0.057 | 8 |
| A | 20 | 0/50 | 367.63 | 169.378 | — / — | 145 |
| A | 100 | 0/50 | 266.80 | 499.082 | — / — | 50 |
| B | 1 | 50/50 | 47.23 | 22.886 | 0.217 / 0.363 | 0 |
| B | 20 | 50/50 | 48.39 | 413.860 | 16.239 / 29.984 | 0 |
| B | 100 | 50/50 | 76.73 | 1979.434 | 83.611 / 135.540 | 0 |
| C | 1 | 50/50 | 13.51 | 2.719 | 0.238 / 0.687 | 0 |
| C | 20 | 50/50 | 14.84 | 3.720 | 15.375 / 27.234 | 0 |
| C | 100 | 50/50 | 15.15 | 6.917 | 83.670 / 134.154 | 0 |
| D | 1 | 50/50 | 14.77 | 2.521 | 0.299 / 0.609 | 0 |
| D | 20 | 50/50 | 15.79 | 3.973 | 4.089 / 8.819 | 0 |
| D | 100 | 50/50 | 17.66 | 7.113 | 21.134 / 30.723 | 0 |

*These are object-associated **whole-isolate** samples across the run, not isolated per-request allocations or guaranteed peaks. A/1 concurrent requests all succeeded, yet their associated isolate samples include eight memory-error observations. The data cannot attribute those errors to a particular request or co-located workload, and post-fanout resident continuity was not checked. Counters are observations, not a count of failed requests. C excludes its separate proxy CPU; D excludes separate URL-serving work here. Those Worker scopes are reported separately below. No sampled CPU-limit errors occurred.

### Added transport code and coverage

| Variant | Added transport lines | Provider coverage | Main limitation |
| --- | ---: | --- | --- |
| A | 0 | Stock Pi image adapters | Inline journal/context allocations fail at 20 images |
| B | 342 | Tested Chat, Responses and Anthropic shapes | Base64 encoding CPU remains in the agent DO |
| C | 386 | Same shapes as B | Separate Worker, extra hop, 256 KiB marker-JSON cap |
| D | 206 | URL-capable Chat/Responses; synthetic Anthropic URL receiver | Real provider/model URL support must be verified |

Lines count the shared marker plus the selected transport, excluding harness, fixtures and fake provider. B is `marker.ts` + `stream.ts`; C adds `proxy.ts`; D is `marker.ts` + `signed.ts`. The shared main Worker bundle is 3,170.41 KiB (803.49 KiB gzip), proxy 14.28 KiB (4.58 KiB gzip), and fake provider 16.18 KiB (4.63 KiB gzip). Main includes all modes, Pi and code-mode WASM; these are not independent per-design bundles.

<!-- PHASE_METRICS -->
The phase query made 93 requests: 31 measurement windows × three exact script filters. All succeeded. MAIN had data in all 31 windows; PROXY and PROVIDER were empty in every window. Their CPU and memory remain **unavailable**, not zero. The whole-run query also returned no proxy/provider rows. Consequently, no total-CPU ranking of B versus C is established.

| Case | Main Worker CPU in window (ms) | Main isolate largest-row P99 (MiB) | Reported invocations in window | Separate proxy CPU / memory |
| --- | ---: | ---: | ---: | --- |
| B, single 100 | 3.377 | 11.03 | 4 | Unavailable |
| C, single 100 | 1.720 | 9.28 | 2 | Unavailable |
| D, single 100 | 181.904 | 11.52 | 104 | Unavailable |
| B, 50 × 100 | 142.532 | 11.18 | 142 | Unavailable |
| C, 50 × 100 | 212.050 | 11.32 | 200 | Unavailable |
| D, 50 × 100 | 5256.660 | 11.56 | 5161 | Unavailable |

MAIN includes dispatch and D's signed-image serving. These invocation quantiles are not DO maxima, and the request windows include the single-case hold. Inclusive time boundaries and adaptive aggregation mean the invocation count is a window observation, not an exact count of the case's API calls. Do not sum overlapping phase windows for billing.

<!-- /PHASE_METRICS -->
<!-- /COMPARISON -->

## What ran

All measured cases run on actual deployed Workers in the camelAI account. The
owned names are `camelrun-proto-image-streaming`,
`camelrun-proto-image-proxy`, and `camelrun-proto-image-provider`. The first
owns one SQLite DO namespace and one private R2 bucket. The fake provider is
a separate Worker and incrementally decodes and hashes incoming images; it
does not accumulate the large JSON body. C adds another stateless Worker
between the agent and that receiver. A, B and D use the same receiver directly.

| Variant | Stored Pi image | Outgoing request |
| --- | --- | --- |
| A: inline baseline | Full base64 derivative in a stock `ImageContent` | Stock pi-ai JSON string and base64/data URL |
| B: streaming in the DO | Valid tiny PNG containing an immutable derivative reference | Expand recognized image fields through `FixedLengthStream` |
| C: proxy Worker | Same marker | Send small marker JSON through a service binding; proxy runs B's expansion |
| D: signed URLs | Same marker | Substitute short-lived HMAC URLs; the receiver fetches and hashes the private R2 object |

The shared corpus is 100 distinct synthetic 1600 × 1200 PNGs. A title bar and
sidebar surround independent RGB noise. The deployed Images binding creates
1568-pixel-bounded PNG derivatives, with a 5 MiB output cap. The runner refuses
derivatives below 2 MiB. These are intentionally difficult-to-compress stress
fixtures, not a representative screenshot distribution or an OCR-quality study.
Original and derivative SHA-256 values and byte counts are retained. Provider
hashes must match the **derivative sent**, not the differently encoded original.
Derivatives range from 4,690,453 to 4,691,088 bytes and total 469,073,116 bytes.
The 100-image B/C request is 625,445,341 bytes, with an exact matching declared
length. Its Pi database is 217,088 bytes after seeding; the 20-image inline
baseline already occupies 125,501,440 database bytes before its request fails.

Each single case has its own named DO. A real Pi Harness appends and reloads
the images from SQLite; the actual pi-ai adapter then constructs its request.
The performance matrix is A–D at 1, 20 and 100 images through OpenAI Chat.
One-image cases additionally exercise OpenAI Responses and Anthropic Messages.
No real OpenAI, Anthropic, Azure, Google or AWS credentials are used.

The 50-agent matrix starts 50 workflows together for each variant/count. Each
workflow seeds its own journal and requests when ready; this is not a barrier
that makes all 50 provider requests start on the same instant. Single cases run
once in fixed order against a warm derivative corpus. Reported numbers are
observations, not randomized repeated-trial estimates.

## Correctness and Pi behavior

All nine retry/abort/missing-object checks passed. All three forced-eviction
replays and Pi lifecycle probes passed, including completed compaction outcomes.
Each retry used two adapter calls; each recovery matched all 20 expected images.
An independent receiver audit verified 530 completed requests, 18,812 images
and 88,242,002,722 decoded bytes against the manifest. A accounts for 53 images;
B, C and D each account for 6,253. Fifty-three other request outcomes were the
expected baseline and fault cases. No unexpected failure was found.

The receiver checks every image's SHA-256, byte count and ordering. B/C also
require the declared Content-Length to equal consumed bytes, with no
Transfer-Encoding. Base64 chunks are aligned to three input bytes; the final
chunk alone carries padding. The expanded length is computed before sending:
UTF-8 JSON bytes plus `4 * ceil(imageBytes / 3)` for each image.
Those framing checks use service bindings between real deployed Workers.
External HTTPS provider acceptance remains unverified. C also caps its entire
marker JSON at 256 KiB, including text and schemas; B has no corresponding cap.

Every adapter retry reconstructs the stream and reopens R2 objects. Failure
injection returns HTTP 503 after consuming part of B/C's request body, or part
of D's separate image download. These are deliberate partial-transfer
rejections, not a simulation of every possible TCP failure. Abort and missing
object cases use separate agents, followed by clean recovery where applicable.
The live abort timer proves rejection and recovery, not a measured receiver-side
byte offset or confirmation that every remote read stopped. Local tests cover
active stream cancellation.

The Pi probe separately uses ordinary user submission and an actual `afterTool`
hook. It stores both ordinary image output and the native-read-style structured
image output through the same Images/R2 externalizer. It exercises journal
reopen, fork, manual compaction, nested read and the real code mode WASM
`image()` implementation. Actual platform eviction is a separate `ctx.abort()`
test: the constructor must change while the object ID and image hashes remain.
The probe tests a user-image fork and reopen before later tool and compaction
steps. It does not exhaust every ordering of fork, compaction and eviction, or
scan every raw checkpoint for retained original bytes.

A base64 encoding of plain `ref:...` fails code mode image validation. The
marker is instead a complete 1×1 PNG with a CRC-checked iTXt reference chunk.
It remains syntactically valid base64 and passes the real PNG header checks.
The reference includes key, derivative byte size, MIME and SHA-256. It is a private
host protocol, not a native Pi reference type.

Pi estimates an image as 4,800 characters / 3.5, rounded up: **1,372 tokens**.
The original and marker get the same estimate. Replacing data therefore does
not itself make images disappear from this heuristic. Fake provider usage does
not validate production compaction thresholds or provider-specific image tokens.
Manual compaction proves lifecycle acceptance and retained-history behavior;
it does not prove useful visual summaries from a real model.

Native Pi read checks also exercise a small valid PNG, rejection of a 5 MiB
file before reading its full body, and rejection of a 3,000-pixel-wide header.
Their filesystem capabilities are fixtures. The host must enforce real input,
pixel and derivative caps before replacing data: a tiny marker cannot enforce
the size of the object it references.

## Provider coverage

| Pinned adapter | Custom fetch | Evidence and limit |
| --- | --- | --- |
| Anthropic Messages | Yes | Deployed shape plus actual local SDK adapter; direct API URL shape documented |
| OpenAI Chat / Responses | Yes | Deployed adapters and all-image hash checks |
| OpenRouter / DeepSeek-style endpoint | Yes, through Chat | Actual local adapter calls; does not make a text-only model vision-capable |
| Azure Responses | Yes | Actual local SDK adapter; deployed Azure service not called |
| Google Generative / Vertex | No | Installed adapters explicitly reject custom fetch |
| Bedrock Converse | No | Installed adapter uses its AWS client and does not consume this option |

The real Smithy SigV4 test hashes the expanded stream once, reconstructs it,
and obtains the same signature as a fully materialized expanded body. Signing
the marker body produces a different signature. A two-pass transport is
mechanically possible, but it does not create a hook in Pi's Bedrock adapter
or undo its earlier image base64-to-bytes conversion. It doubles reads and
encoding for each attempt. This is an offline test with synthetic credentials,
not an AWS request. See [provider audit](docs/provider-audit.md).

The optional Workers AI vision attempt returned HTTP 502 / `AiError 5016`:
the selected model requires a license acknowledgment. No terms were accepted
and no real-model vision check completed. Provider URL acceptance and visual
answer quality therefore remain unverified.

## Memory and timing interpretation

The final 51 DO polls contain 830 distinct rows, with 14 initially empty polls and no API errors. Every one of the 20 single cases and 600 concurrent agents has associated DO telemetry. Memory comes from Cloudflare GraphQL `durableObjectsPeriodicGroups`, matched
by namespace and named object. It measures the **whole isolate**, including
co-located objects and allocations; it is not per-agent heap or a guaranteed
peak. Repeated polls of the same object/time row are deduplicated. Missing rows
remain unavailable, never zero. Over-limit samples do not establish usable
capacity beyond Cloudflare's limit. Counter sums are observations, not unique
user-visible failure counts.

DO CPU and duration rows include seed, request, deliberate hold and status work.
Provider elapsed time is measured before the 30-second telemetry hold; public
client latency includes it. Concurrent groups have no hold. Successful-only
latency denominators are retained so fast failures cannot make a design look
faster. The stateless Workers have separately scoped invocation queries; their
data must not be added to DO data as if both described disjoint billable work.

## Remaining work and ECS

- Resolve trusted references for UI, file reads, exports and saved code mode
  artifacts. Without that, an artifact can contain the marker PNG. The probe
  has no execution filesystem and reports that artifact saving was unavailable.
- Enforce tenant/agent ownership, retention across forks, erasure and immutable
  object versions. B/C check size and the fake receiver verifies hashes, but
  they do not enforce production tenant authorization or content immutability.
  D's HMAC and prefix checks are confined to this experiment's private bucket.
  URL expiry, tampering and path-scope rejection have local test coverage. The
  URL lifetime is 120 seconds (maximum 300); queueing and fetch time consume it.
- Cover arbitrary nested structured outputs. The hook handles ordinary output
  and a schema-aware image result; this is not a universal object traversal.
- Keep production request-byte, image-count and pixel limits. Streaming avoids
  a giant allocation; it does not expand provider limits. PNG results do not
  establish JPEG MIME rewriting: B/C must update the provider MIME when the
  actual derivative differs from the marker PNG.
- Bound image creation and ingestion before the hook. An `afterTool` hook
  cannot undo a huge base64 array already allocated by a tool. Likewise, parsing
  one enormous inline user JSON body can fail before image externalization.
  This experiment uploads originals separately and reads one derivative at a time.
- Gate transport selection. A valid PNG marker sent through an unsupported
  adapter could silently become a blank pixel. Unsupported paths must reject it
  or use an explicitly supported bounded fallback.

For ECS, retain its existing inspection/isolated resize, newest-first 20 MiB
base64 request budget, image-count limits, FileRef pins and outbound policy.
Externalize prompt, steer and tool images before Pi writes, and compose the
reference transport with `src/compaction.ts`'s existing per-call fetch. Replace
base64 values in hydration/IPC caches with metadata. Node needs a rebuilt
stream with exact Content-Length and, where required, `duplex: 'half'` instead
of Workers' `FixedLengthStream`. Do not give every agent the bucket credential.
[The ECS integration map](docs/ecs.md) names the current files and remaining gates.

## Reproduction, spend and cleanup

Commands run from this package, unless stated otherwise:

| Command | Result |
| --- | --- |
| `npm ci` | Installed the pinned experiment dependencies |
| `npm test` | 30 tests passed, including actual Pi SDK fetch hooks and two-pass Smithy signing |
| `npm run typecheck` | Passed |
| `npm run build` | All three Wrangler dry-run bundles passed |
| `node --check scripts/phase-telemetry.mjs` | Passed |
| `node scripts/cloud.mjs --smoke` | Four retained iteration runs; the first two stopped during ingestion, the third found URL transport configuration failures, the fourth found retry/probe fixture gaps fixed before the full run |
| `node scripts/cloud.mjs` | Passed: 20 single cases, 12 groups of 50, nine fault cases and three replay/Pi probes; expected baseline failures retained |
| `node scripts/verify-results.mjs measurements/cloud-2026-11-05T17-46-30-212Z.json.gz` | 41,050 / 41,050 checks passed, including cleanup |
| `node scripts/report.mjs measurements/cloud-2026-11-05T17-46-30-212Z.json.gz` | Reduces retained evidence to `measurements/comparison.json` |
| `node scripts/phase-telemetry.mjs measurements/cloud-2026-11-05T17-46-30-212Z.json --include-provider` | 93 successful queries; service-bound proxy/provider rows absent |
| Root `npm run typecheck` | Passed |
| Root `npm run docs` | Passed |
| Root `node --experimental-strip-types --test --test-name-pattern='^llms.txt' tests/docs.test.ts` | Freshness and link checks passed |
| `git diff --check` | Passed |

The broader, unanchored docs-test pattern also selected HTTP server fixtures.
That attempt could not run without the built `v8-exec` binary. No application
runtime suite or production end-to-end test is claimed for this isolated package.
Raw successful and failed smoke attempts are retained under `measurements/`;
they are not silently replaced by later passes.

Pricing uses the published [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/), and
[Images](https://developers.cloudflare.com/images/pricing/) rates. A usage-rate
estimate is not an account invoice: included usage, billing-unit rounding,
existing plan fees and unrelated account traffic prevent exact attribution.

The full run's visible rate-equivalent subtotal is **$0.19986**, before included
usage and billing-unit rounding. It consists of 2,125.181 DO GB-seconds
($0.02656), 170,170 SQL row writes ($0.17017), 406,114 row reads ($0.00041),
20.725 seconds of main Worker CPU ($0.00041), and 7,673 main Worker requests
($0.00230). DO CPU totals 3,200.850 seconds; DO billing uses duration rather
than adding that CPU figure to the Worker CPU charge.

That subtotal excludes unreported proxy/provider CPU, Images, R2 and storage.
The retained full run bounds unreported service invocations at 748; the four
setup smokes add at most 84. Even charging 1,000 such invocations their full
configured 300-second CPU cap gives $6. Allowing a whole additional billable
unit for DO duration ($12.50), SQL writes ($1), R2 writes ($4.50) and reads
($0.36), plus requests, storage and transforms, gives a **conservative incremental
envelope below $30 for this work**, including setup smokes. This is deliberately
an upper bound, not a measured bill or a claim that missing CPU was free.
The roughly $5 reported before this work is separate. No paid real-model
inference succeeded and no production service was changed.

The full deployed run started at `2026-11-05T17:46:30.212Z`; measurements
finished at `18:18:39.988Z`. After eight final telemetry polls, cleanup completed
at `18:24:18.623Z` with no errors:

- Deleted 303 R2 objects and the private bucket.
- Deleted the DO class by migration; the namespace inventory is empty.
- Deleted all three `camelrun-proto-*` Workers; the exact-name inventory is empty.
- All three former Worker endpoints returned HTTP 404.
- Every earlier smoke report also confirms empty Worker, namespace and bucket inventories.

Authoritative artifacts are `measurements/cloud-2026-11-05T17-46-30-212Z.json.gz`,
`measurements/verification.json`, `measurements/comparison.json`, and
`measurements/phase-telemetry.json`. The first phase-query attempt was blocked
by the local network sandbox and is retained separately as
`measurements/phase-telemetry-network-failure.json`; the authorized read-only
retry completed all 93 queries. No credentials or signed image capabilities
were found in the retained evidence scan.

The full raw JSON was archived losslessly after cleanup: 15,007,140 bytes to
1,046,182 bytes. `measurements/archive-manifest.json` records both SHA-256
values and the round-trip check. All three report tools accept `.json.gz`; the
phase query above ran against the original JSON before archival. Console-log
trailing whitespace was normalized for review.
