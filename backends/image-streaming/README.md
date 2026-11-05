# Image request streaming experiment

This directory is an isolated experiment. It does not change the ECS runtime or
vendored Pi. Start with `RESULTS.md` for measurements and limits.

## Run

From this directory, with Node 22.21 or newer:

```sh
npm ci
npm run typecheck
npm test
npm run build
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

The three report tools accept plain `.json` or gzip-compressed `.json.gz` files.
The default report search recognizes both formats.

`CLOUDFLARE_API_TOKEN` is read from the environment. Its value is never written to
the report. The experiment bearer is generated in process memory and installed
through Wrangler stdin. Do not pass either credential as an argument.
`CLOUDFLARE_ACCOUNT_ID` and `IMAGE_EXPERIMENT_WORKERS_DOMAIN` can override the
account and workers.dev suffix, but the checked-in Wrangler configs must target
the same account and the main Worker's `PUBLIC_ORIGIN` must match that suffix.

The runner refuses an existing exact-name Worker, DO namespace or bucket. It
owns only `camelrun-proto-image-streaming`, `camelrun-proto-image-proxy`, and
`camelrun-proto-image-provider`, plus the first name's bucket and DO namespace.
Do not run two copies at once. A local lock catches runs in this worktree; cloud
preflight catches existing resources from another host. Every exit path attempts
to drain the bucket, delete the DO class through a migration, delete the three
Workers and bucket, and verify the final inventory and public endpoint status.
Keep the process alive until cleanup completes. The report records any cleanup
failure instead of treating an attempted deletion as success.

## What is measured

The generator creates 100 distinct 1600 × 1200 noisy screenshot-like PNGs, with
independent noise in each RGB channel so real resizing retains a large payload. All
images are synthetic. The actual deployed Images binding creates derivatives;
the full runner refuses derivatives below 2 MiB. It retains SHA-256 and size for
each original and derivative. Expected provider hashes refer to derivatives.

Each single case uses a separate named Durable Object. The full matrix includes
A/B/C/D at 1, 20 and 100 images, OpenAI Chat/Responses and Anthropic adapter
shapes, partial-transfer rejection, abort and missing-object failures, eviction and replay,
and 50 simultaneous agents for every mode/count pair. Baseline failures are
recorded; a reset is not treated as a successful measurement. The streaming
receiver decodes and hashes image bytes without accumulating the request body.

The full runner also makes one Workers AI vision call through the AI binding.
It records a model error as an observation; no external provider credential is
used. The fake-provider checks remain the byte-correctness authority.

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
| `scripts/cloud.mjs` | Deployment, corpus, matrix, telemetry and cleanup owner |
| `scripts/fixture.mjs` | Shared deterministic corpus generator |
| `scripts/verify-results.mjs` | Independent completed-run correctness and cleanup checks |
| `scripts/report.mjs` | Deduplicated comparison tables without filling telemetry gaps |
| `scripts/phase-telemetry.mjs` | Read-only per-phase Worker telemetry for proxy/server overhead |
