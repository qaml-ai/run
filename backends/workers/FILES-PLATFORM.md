# Files and platform parity

34 of the 35 files-platform failures reported for PR #653 now pass. The complete
account export remains missing. The source runtime remains the specification.
No product assertion is relaxed.

## Changes

- File arguments stay off for external tools unless their definition enables
  them. Enabled tools receive mount-authorized bytes or call-bound URLs. URLs
  retain file versions and directory snapshots and carry call identity and expiry.
- MCP and OpenAPI file inputs support their declared transport. Binary, image,
  audio and long text results are retained in the workspace. Download responses
  use the source sandbox headers, and fetched redirects are checked separately.
- REST attachments retain immutable references in history. Provider requests
  apply source image count, byte and dimension limits. A failed resize is retried
  on the next request. PDFs are inspected before native document selection.
- Image generation uses the configured transport and source key, billing and
  admission policy. Volume requests replay their idempotent responses.
- Search and rendering use tenant keys before platform keys, preserve provider
  prices, meter auxiliary usage and recheck credit between calls. Nested
  codemode calls receive structured results and the source error shape.
- Workspace inheritance, schedule email policy, self-hosted errors and browser
  URLs match the source. CLI creation and reconfiguration keep their public
  status and request identifiers.
- Journey event policy is shared with Node through `src/core/journey.ts`.
  Workers supplies database, request lifetime and bound fetch services. Console
  pages serve at the mounted path and add journey metadata only when enabled.

The file-argument schema and resolution policy also move to
`src/core/file-arguments.ts`. Node imports the same implementation. These are
source extractions, not new generated copies.

## Verification

The final tested revision is `3e2d2e618e8ee4b4eb4d047d905544d486e7e35b`,
rebased onto `bcc21c4e` (the models, tools-MCP and harness-speed tracks).
Its runtime source is unchanged from the earlier `b65f6aeb` verification.
The final suite hash is
`fabe683775fe343cc1c227f56f728a869eff7d15d2552fd4ee40db9c2129e413`;
the Node baseline key is
`1ff65be69bdb97687bb551ad863a1ab48c42d7c4726928e25ab5efd896fabdfc`.

The 51 scoped checks finish at **Node 51 pass; Workers 50 pass, 1 fail**. Two
checks only exercise SDK configuration: the HTTP totals are Node 49/49 and
Workers 48/49. Compared with the
[PR #653 report at its recorded revision](https://github.com/qaml-ai/run/blob/0a96eb16970a2017cef6c379615f212bc3bad685/backends/workers/measurements/parity-workers.json),
39 failures become passes, 11 passes remain passes, and one failure remains.
Of the user's 35 reported failures, 34 become passes.

| Area | Node pass | Workers pass | Workers fail |
| --- | ---: | ---: | ---: |
| Files | 14 | 14 | 0 |
| Images | 6 | 6 | 0 |
| Volumes | 5 | 5 | 0 |
| Search | 7 | 7 | 0 |
| Schedules | 3 | 3 | 0 |
| Workspaces | 1 | 1 | 0 |
| Self-hosting | 3 | 3 | 0 |
| CLI (includes two SDK-only checks) | 7 | 7 | 0 |
| Journey | 5 | 4 | 1 |

[The case-by-case comparison](measurements/files-platform/comparison.json)
identifies every reported case and its before/after status. The final
[Node](measurements/files-platform/final-node.json) and
[Workers](measurements/files-platform/final-workers.json) reports are the
harness's validated merges of four disjoint shards each. They retain every
case and record source keys, revision, runtime and shard durations.

| Phase / shard | Sprite / run | Pass / fail | Raw report |
| --- | --- | ---: | --- |
| node 1/4 | `rt-pool-21` / `20261105-164112-38008-1` | 13 / 0 | [node-shard-1.json](measurements/files-platform/node-shard-1.json) |
| node 2/4 | `rt-pool-22` / `20261105-164112-38008-2` | 13 / 0 | [node-shard-2.json](measurements/files-platform/node-shard-2.json) |
| node 3/4 | `rt-pool-23` / `20261105-164112-38008-3` | 13 / 0 | [node-shard-3.json](measurements/files-platform/node-shard-3.json) |
| node 4/4 | `rt-pool-24` / `20261105-164112-38008-4` | 12 / 0 | [node-shard-4.json](measurements/files-platform/node-shard-4.json) |
| workers 1/4 | `rt-pool-21` / `20261105-164242-42823-1` | 13 / 0 | [workers-shard-1.json](measurements/files-platform/workers-shard-1.json) |
| workers 2/4 | `rt-pool-22` / `20261105-164242-42823-2` | 12 / 1 | [workers-shard-2.json](measurements/files-platform/workers-shard-2.json) |
| workers 3/4 | `rt-pool-23` / `20261105-164242-42823-3` | 13 / 0 | [workers-shard-3.json](measurements/files-platform/workers-shard-3.json) |
| workers 4/4 | `rt-pool-24` / `20261105-164242-42823-4` | 12 / 0 | [workers-shard-4.json](measurements/files-platform/workers-shard-4.json) |

The new harness ran only this group's 51 cases on the Sprite pool:

```sh
AREAS=files,volumes,images,search,schedules,workspaces,selfhost,cli,journey
npm run parity -- --area="$AREAS" --shards=4
node tests/contract/run.mjs --backend=node --area="$AREAS" --merge=backends/workers/measurements/runs/2026-11-05T22-41-12-443Z-37975/node
npm run parity -- --backend=workers --area="$AREAS" --shards=4
```

All Node shards passed. The first command stopped at local report collection
because the worktree lacked the `jose` inventory dependency. Linking the
existing installed dependencies and merging those unchanged shard reports
produced the green Node baseline; no Node test was rerun. The Workers-only
command then reused that baseline. The original
[Node pool result](measurements/files-platform/node-pool.json) retains that
collection failure; the [Workers pool result](measurements/files-platform/workers-pool.json)
retains the account-export failure. The matching Node baseline is committed
under `measurements/node-baselines/` for reuse.

Workers ran two test files at a time per Sprite. All execution used local
workerd, Postgres and scripted providers. No full 590-case run was started.

The original Node file-argument and tool-file suites pass 11/11. The original
journey and journey-billing suites pass 41/41. Those ran at `7a244b18`; the
`src/` tree is unchanged between that run and the final test revision.
Independent review found the extracted file-argument runtime declarations
unchanged. Commands:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=2 tests/file-arguments.test.ts tests/tool-files.test.ts
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/journey.test.ts tests/journey-billing.test.ts
```

On `rt-pool-27`, run `20261105-164137-39016-1`, the final revision passed root
and Workers typechecks and both assertion guards: 2,516 original public
assertions in ported cases and 620 in product declarations.

Before the harness-only rebase, `b65f6aeb` also passed these on `rt-pool-4`,
run `20261105-163355-16581-1`:

- `npm run build --prefix backends/workers`: both Wrangler dry builds.
- `npm run openapi`: generated `openapi.json` matches the checked-in file.
- `npm run docs` and the `llms.txt` subset of `tests/docs.test.ts`: 2/2.

## Remaining case

`tests/journey-server.test.ts:120`, account export, reaches the store with its
token event but receives HTTP 404 from `GET /v1/account/export`. Workers has no
complete account ZIP exporter. It needs the source export's account, agent
history, volume, billing and analytics data through Workers adapters. A partial
archive would silently omit account data, so this branch leaves the route
unimplemented and the assertion failing. See `src/account-export.ts`.

## Limits requiring follow-up

PDF inspection currently uses the serverless PDF.js build inside the Worker
with byte limits, disabled eval and disabled font loading. It does not reproduce
the source runtime's externally killable parser process. Selecting an isolated
parser host and validating adversarial CPU and memory behavior remain migration
decisions; passing public file contracts does not resolve them.

The local fake providers verify protocol and accounting behavior. These checks
do not establish live provider acceptance, deployed performance or production
readiness. This work creates no deployed Cloudflare resources and makes no
production database changes.
