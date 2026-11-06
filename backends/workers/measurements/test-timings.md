# Test timings

Wall times from GitHub Actions run 42255583344 (main after #678) and from Sprites (8 vCPU nominal, about 4 effective); 2026-11-06. Update when a suite changes by more than 5%.

## CI jobs, per pull request

| Job | Runner | Wall | Notes |
| --- | --- | --- | --- |
| Workers unit | ubuntu-latest | 104 s | `npm test` in backends/workers, 8 files at once (`scripts/run-tests.mjs`) |
| Workers integration, shard 1/3 | ubuntu-latest | 210 s | `--test-shard=1/3`, 2 fixtures at once |
| Workers integration, shard 2/3 | ubuntu-latest | 186 s | |
| Workers integration, shard 3/3 | ubuntu-latest | 172 s | |
| Workers slow (2001-agent deletion test) | blacksmith-4vcpu | nightly only | about 8.5 min |
| test (process 1 to 5 of 5) | blacksmith-8vcpu | 168, 150, 207, 148, 143 s | 346 files, 5,464 file-seconds at 8 files at once; the steps other than the tests take 10 s |
| python | blacksmith-8vcpu | 131 s | |
| sim | blacksmith-16vcpu | 42 s | |
| image (amd64) | blacksmith-16vcpu | 46 s | |
| checks, docs | blacksmith-4vcpu | 38 s, 32 s | |

In vCPU-minutes the five test shards are about 109 of roughly 160 for the blacksmith jobs.

## What was measured and left alone

- **Root suite per-file times** are flat: the longest file (`sim-scenarios-agents`) is 150 s of 5,464 file-seconds (2.7%), the next ten are 70 to 134 s. There are few fixed sleeps (0 to 9 per file in the slowest files); the time is real runtime work (Postgres, v8-exec, cluster processes). The `inline` mode already runs only on main, and sim files run in the process shards on PRs only (`scripts/test-shard.ts`).
- **Migrations per test database** (`tests/database.ts`, 249 calls) cost 0.35 s each on a Sprite, about 90 s of 5,464 (1.6%). A template database (as in backends/workers/test/migrated-database.ts) would save that; below the 5% bar.
- **`NODE_COMPILE_CACHE`** for a root shard (`test:shard 4/5`, 4 files at once on a Sprite): 283 s plain, 280 s cold cache, 275 s warm. About 2%.
- **One long-lived Wrangler fixture per Workers integration file.** 62 `startFixture` calls in 51 files; 17 use the default configuration and only 14 files start more than one. Sharing would save about 12 fixtures (under 15% of serial CPU), cannot cross files (separate processes), and would make tests share state.
- **A prebuilt Wrangler bundle** (`wrangler deploy --dry-run --outdir`, then `no_bundle`). Bundling is about 3 s of each fixture's 5 to 8 s. With `no_bundle` the main worker reaches `reloadStart` but never `reloadComplete`, and `/healthz` never answers; cause not found.
