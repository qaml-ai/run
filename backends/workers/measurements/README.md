# Measurements: key results

The Workers backend is an internal pilot, not a supported deployment. This page
summarizes the results the docs in this directory rely on. Each line names the
document with the method, limits and cleanup. Raw dumps (database profiles, load
runs, TAP logs, older Node baselines) are not kept in the tree; they stay
readable at the
[archived revision](https://github.com/qaml-ai/run/tree/962e764c37f25477aedea47b21ed09fc6242f914/backends/workers/measurements).

## Hibernation

- Deployed pilot, 2026-11-06: an idle event WebSocket stayed open 180,002 ms
  with no frames and then received a wake turn on the same socket. Cloudflare
  reported **0 GB-s** of Durable Object duration in both complete idle minutes.
  [PILOT.md](../PILOT.md), `pilot-smoke.json`, `pilot-hibernation.json`.
- Paired platform probe, 180 s idle each: the WebSocket object recorded
  **0.0188 GB-s** (0.147 active seconds) while SSE recorded **23.1 GB-s**
  (180.5 active seconds); only the WebSocket object was evicted between frames.
  [PLATFORM.md](../PLATFORM.md), `platform-hibernation*.json*`.

## Load (deployed pilot, fake 15 s model, 20 accounts)

PlanetScale PS-80 (1 vCPU, 8 GB, `max_connections=150`), Hyperdrive origin limit
100, every turn of a stage admitted at once. [PILOT.md](../PILOT.md),
`turn-db-ps80-profile.json`, `turn-db-ps80-cleanup.json`,
`turn-db-bigger-telemetry.json`, `planetscale-cpu-bigger-db.json`.

| Concurrent turns | Client errors | Successful turns/s | p50 / p95 / p99 |
| --- | --- | --- | --- |
| 250 | 0/250 | 8.356 | 26.7 / 28.2 / 28.8 s |
| 500 | 0/500 | 12.554 | 35.1 / 37.1 / 38.1 s |
| 1,000 | 5/1,000 (0.5%, client status-poll timeouts) | 16.020 | 55.3 / 61.0 / 61.4 s |

All 1,750 model attempts settled; no pending attempts or credit holds remained.
Earlier runs on smaller database and pool settings had 0.4% to 33% errors at 250
turns and 56% to 63% at 500; PILOT.md has those runs.

## Contract parity

Full `npm run parity` on six Sprites, 2026-11-06 (this branch, before merge to
main), 600.9 s wall time: **Node 525 HTTP + 66 SDK-only pass, 0 fail.
Workers 508 HTTP + 66 SDK-only pass, 17 accepted differences, 0 fail**
(transport 9, tools 3, access 2, SDK 2, history 1; reasons in
`tests/contract/accepted-differences.mjs`). 380 channel/voice cases are out of
scope. Per-case results: [PARITY.md](../PARITY.md), `parity-node.json`,
`parity-workers.json`; harness timing history: [parity-speed.md](parity-speed.md).

## Test timings

Same date and tree, one Sprite (8 CPUs) per command:

| Suite | Tests | Wall time |
| --- | ---: | ---: |
| Workers unit (`node scripts/run-tests.mjs unit`) | 524 pass | 757 s including `npm ci` |
| Workers integration shard 1/3 (2,001-agent account deletion alone) | 1 pass | 829 s (the test: 792 s) |
| Workers integration shard 2/3 | 64 pass | 274 s |
| Workers integration shard 3/3 | 44 pass, 1 skipped | 318 s |

The deletion test bounds the integration suite; CI gives its shard a 4 vCPU
runner.
