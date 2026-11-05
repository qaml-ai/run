# Image request streaming experiment

This directory is an isolated experiment. It does not change the ECS runtime or
vendored Pi. Start with `RESULTS.md` for measurements and limits.

## Run

Use Node 22.21 or newer. Run typechecking, tests and Wrangler dry-run builds on
the shared Sprite pool, not the laptop. From the repository root, after committing
the changes to test:

```sh
scripts/sprite-test HEAD bash -lc '
  set -e
  cd backends/image-streaming
  npm ci
  npm run typecheck
  npm test
  npm run build
  npx wrangler deploy --dry-run -c wrangler.realistic.jsonc --outdir dist-realistic
  npx wrangler deploy --dry-run -c wrangler.realistic-provider.jsonc --outdir dist-realistic-provider
'
```

The Sprite command copies the committed tree at `HEAD`; it does not test
uncommitted files. It requires the `sprite` CLI signed into the `camelai` org.
See the [Sprite instructions](../../.agents/skills/sprites-agent-runtime/SKILL.md).

Run the cloud orchestrator from this directory. It deploys the actual Workers
and does not require a local application build:

```sh
npm ci
# The existing Cloudflare API credential must be in the process environment.
# A smoke deploy checks one image, adapters, faults and replay, then deletes everything.
npm run cloud -- --smoke
# Full corpus, faults, replay, telemetry and 50 simultaneous agents per case.
npm run cloud
# Replace the filename with the report printed by the runner.
node scripts/verify-results.mjs measurements/cloud-YYYY-MM-DDTHH-MM-SS-mmmZ.json
node scripts/report.mjs measurements/cloud-YYYY-MM-DDTHH-MM-SS-mmmZ.json
# Optional delayed, read-only CPU/memory queries for each measurement window.
node scripts/phase-telemetry.mjs measurements/cloud-YYYY-MM-DDTHH-MM-SS-mmmZ.json
# Reduce the retained cloud observations into comparison.json; no network access.
node scripts/report.mjs
```

The original commands above retain the large-PNG A/B/C/D stress profile. The
realistic profile uses the same harness with B/D and smaller JPEG derivatives:

```sh
# One accepted JPEG, adapter shapes, faults, replay and the real-model check.
npm run cloud -- --realistic --smoke
# 100 accepted JPEGs, B/D at 1/20/100 images, and 50 agents per case.
npm run cloud -- --realistic
# Only the bounded real-model check, telemetry and cleanup.
npm run cloud -- --realistic --vision-only --smoke
# Verify a completed realistic matrix; vision-only reports have no matrix.
node scripts/verify-results.mjs measurements/cloud-realistic-YYYY-MM-DDTHH-MM-SS-mmmZ.json
node scripts/report.mjs measurements/cloud-realistic-YYYY-MM-DDTHH-MM-SS-mmmZ.json
node scripts/summarize-realistic.mjs measurements/cloud-realistic-YYYY-MM-DDTHH-MM-SS-mmmZ.json
node scripts/phase-telemetry.mjs measurements/cloud-realistic-YYYY-MM-DDTHH-MM-SS-mmmZ.json
```

The report tools accept plain `.json` or gzip-compressed `.json.gz` files.
The default report search recognizes both formats. Realistic reductions write
`comparison-realistic.json` and `phase-telemetry-realistic.json`.

`CLOUDFLARE_API_TOKEN` is read from the environment. Its value is never written to
the report. The experiment bearer is generated in process memory and installed
through Wrangler stdin. Do not pass either credential as an argument.
`CLOUDFLARE_ACCOUNT_ID` and `IMAGE_EXPERIMENT_WORKERS_DOMAIN` can override the
account and workers.dev suffix, but the checked-in Wrangler configs must target
the same account and the main Worker's `PUBLIC_ORIGIN` must match that suffix.

The runner refuses an existing exact-name Worker, DO namespace or bucket. There
are two separate deployed profiles:

| Profile | Workers | Agent CPU limit |
| --- | --- | ---: |
| Large PNG | `camelrun-proto-image-streaming`, `camelrun-proto-image-proxy`, `camelrun-proto-image-provider` | 300 seconds |
| Realistic JPEG | `camelrun-proto-image-realistic`, `camelrun-proto-image-realistic-provider` | 30 seconds |

Each profile's first Worker owns a private bucket and SQLite DO namespace.
The bucket has the Worker's name. The realistic provider also has a 30-second CPU limit. These are
CPU budgets per invocation, not elapsed-time deadlines. Do not run two copies
at once. A local lock catches runs in this worktree; cloud preflight catches
existing resources from another host. Every exit path attempts
to drain the bucket, delete the DO class through a migration, delete the profile's
Workers and bucket, and verify the final inventory and public endpoint status.
Keep the process alive until cleanup completes. The report records any cleanup
failure instead of treating an attempted deletion as success.

## What is measured

The original generator creates 100 distinct 1600 × 1200 noisy screenshot-like
PNGs, with independent noise in each RGB channel so real resizing retains a
large payload. All images in that profile are synthetic. The actual deployed
Images binding creates derivatives;
the full runner refuses derivatives below 2 MiB. It retains SHA-256 and size for
each original and derivative. Expected provider hashes refer to derivatives.

The realistic profile considers up to 240 pinned Wikimedia source candidates:
20 screenshots and 220 photos. `scripts/realistic-sources.json` records each
source URL, revision hash, author and license metadata; image payloads are not
checked in. Downloads have a 12 MiB cap and must match the pinned SHA-1. The
deployed Images binding bounds dimensions to 1568 pixels and tries JPEG quality
82, 72 and 90, stopping at the first derivative between **200,000 and 400,000
bytes**. The runner continues through candidates until it has 100 accepted
images, or fails if it runs out. Rejected sizes and download failures remain in
the report. This is selection by encoded size, not a representative image sample.

Each single case uses a separate named Durable Object. The full matrix includes
A/B/C/D at 1, 20 and 100 images, OpenAI Chat/Responses and Anthropic adapter
shapes, partial-transfer rejection, abort and missing-object failures, eviction and replay,
and 50 simultaneous agents for every mode/count pair. Baseline failures are
recorded; a reset is not treated as a successful measurement. The streaming
receiver decodes and hashes image bytes without accumulating the request body.
The realistic profile runs the same cases for B/D only, verifies JPEG MIME as
well as hashes, and checks that returned configuration reports the 30-second
CPU budget.

The realistic profile also calls `@cf/meta/llama-3.2-11b-vision-instruct` inside
an ImageAgent Durable Object. Its separate 512 × 320 PNG fixture has a red square
on the left and a blue circle on the right, with no answer text in the pixels.
A Pi image marker passes through the stock Chat adapter and B's
`FixedLengthStream`. A bounded bridge checks exact length and SHA-256, buffers
that one image, and calls the AI binding with `image: number[]`. Actual model
text returns through Chat SSE to Pi. The bridge caps the PNG at 128 KiB, JSON at
256 KiB and generated output at 80 tokens. The retained successful check used a
2,844-byte PNG and 4,202-byte request; the model answered
`Left: Red Square; Right: Blue Circle.`

Workers AI receives a buffered array, not streaming HTTP. This check covers one
small image and does not establish large-image memory scaling, external HTTPS
provider streaming, or a new journal/replay test. The original PNG profile keeps
its earlier signed-URL vision attempt; its error is retained. No external
provider credential is used. The fake-provider checks remain the byte-correctness
authority for the matrix.

Cloudflare GraphQL periodic metrics provide isolate memory, CPU, active duration
and memory/CPU error counters. The report retains every response and error,
including empty telemetry polls. These are periodic samples of a whole isolate,
possibly containing several Durable Objects, rather than peak heap measurements
or isolated per-agent allocations. Worker invocation metrics are queried
separately for the stateless proxy and fake provider. Missing rows remain
unverified; they are never zero-filled. Client latency includes network and
explicit hold time; the Worker also returns request elapsed time before the
telemetry hold.

Reports are timestamped JSON under `measurements/`. Failed attempts stay as
separate evidence. They contain no image payloads, credentials or signed image
capabilities. Exact invocation counts and measured active duration support a
bounded cost estimate; this experiment cannot attribute the account's total
invoice to itself.

## Files

| File | Purpose |
| --- | --- |
| `src/marker.ts` | Valid 1×1 PNG marker containing an immutable image reference |
| `src/stream.ts` | Image-field substitution into a fixed-length streamed request |
| `src/proxy.ts` | Stateless service-binding transport using the same substitution |
| `src/signed.ts` | Short-lived HMAC image URLs and private R2 serving |
| `src/fake-provider.ts` | Bounded streaming image decoder and SHA-256 receiver |
| `src/worker.ts` | Actual Pi/SQLite Durable Object, ingestion and experiment routes |
| `src/vision.ts`, `src/vision-fixture.ts` | One bounded real-model check through B and the AI binding |
| `scripts/cloud.mjs` | Deployment, corpus, matrix, telemetry and cleanup owner |
| `scripts/fixture.mjs` | Shared deterministic corpus generator |
| `scripts/realistic-fixtures.mjs`, `scripts/realistic-sources.json` | Pinned Wikimedia candidate download and provenance |
| `scripts/verify-results.mjs` | Independent completed-run correctness and cleanup checks |
| `scripts/report.mjs` | Deduplicated comparison tables without filling telemetry gaps |
| `scripts/summarize-realistic.mjs` | Per-object CPU, telemetry coverage and realistic-corpus totals |
| `scripts/phase-telemetry.mjs` | Read-only per-phase Worker telemetry for proxy/server overhead |
