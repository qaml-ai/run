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

The tested revision is `b65f6aebdb4546e2f499a1913bfe45db50f66a28`, rebased onto
`8db58007` (the models and tools-MCP tracks). All four runs have suite hash
`3a3056b0e7be9ca9594ea0079378a7b11261cbd645eb7e731782b2a7ae59b39e`.

The 51 scoped checks finish at **Node 51 pass; Workers 50 pass, 1 fail**. Two
checks only exercise SDK configuration: the HTTP totals are Node 49/49 and
Workers 48/49. Against the checked-in PR #653 report, 39 failures become passes,
11 passes remain passes, and one failure remains. Of the user's 35 reported
failures, 34 become passes.

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
identifies every reported case and its before/after status. The aggregate
[Node](measurements/files-platform/final-node.json) and
[Workers](measurements/files-platform/final-workers.json) reports concatenate
the disjoint inventories below. They check the common revision, suite hash and
runtime, preserve every row, and record each source report.

| Areas | Sprite / run | Node report | Workers report |
| --- | --- | --- | --- |
| `images` | `rt-pool-20` / `20261105-163347-15607-1` | [Node](measurements/files-platform/images-node.json) | [Workers](measurements/files-platform/images-workers.json) |
| `files,volumes` | `rt-pool-22` / `20261105-163347-15674-1` | [Node](measurements/files-platform/files-node.json) | [Workers](measurements/files-platform/files-workers.json) |
| `search` | `rt-pool-5` / `20261105-163346-15567-1` | [Node](measurements/files-platform/search-node.json) | [Workers](measurements/files-platform/search-workers.json) |
| `schedules,workspaces,selfhost,cli,journey` | `rt-pool-21` / `20261105-163347-15684-1` | [Node](measurements/files-platform/misc-node.json) | [Workers](measurements/files-platform/misc-workers.json) |

Each area bucket ran through `scripts/sprite-test HEAD bash -lc ...`, with
Workers dependencies and Python SDK requirements installed on the Sprite:

```sh
export CONTRACT_REVISION=b65f6aebdb4546e2f499a1913bfe45db50f66a28
CONTRACT_CONCURRENCY=2 npm run parity -- --backend=node --area="$AREA"
CONTRACT_CONCURRENCY=1 npm run parity -- --backend=workers --area="$AREA"
```

The Node gate is green for each exact suite before Workers runs. Workers
fixtures run serially on each Sprite. An earlier four-fixture run hit a local
workerd port collision; this revision also includes the integration branch's
direct HTTP socket launcher. All execution uses local workerd, Postgres and
scripted providers. The full 590-case comparison remains the coordinator's job.

The original Node file-argument and tool-file suites pass 11/11. The original
journey and journey-billing suites pass 41/41. Those run at `7a244b18`; the
`src/` tree is unchanged between that run and the rebased test revision.
Independent review found the extracted file-argument runtime declarations
unchanged. Commands:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test --test-concurrency=2 tests/file-arguments.test.ts tests/tool-files.test.ts
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/journey.test.ts tests/journey-billing.test.ts
```

On `rt-pool-4`, run `20261105-163355-16581-1`, these also pass:

- `npm run typecheck` and `npm run typecheck --prefix backends/workers`.
- `npm run build --prefix backends/workers`: both Wrangler dry builds.
- `npm run openapi`: generated `openapi.json` matches the checked-in file.
- `npm run docs` and the `llms.txt` subset of `tests/docs.test.ts`: 2/2.
- `node tests/contract/check-assertions.mjs`: 2,516 original public assertions.
- `node tests/contract/check-product-assertions.mjs`: 620 original assertions.

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
