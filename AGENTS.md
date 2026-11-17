# Working in camelRun (for coding agents)

camelRun (qaml-ai/run) is the agent runtime behind https://run.camelai.com: a Node.js server that runs each agent's
model loop, keeps its history and files in Postgres and object storage, and runs codemode on v8-exec (`sandbox/`).
Main deploys to production by itself once CI passes, so main is production: test before merging.

## Build and test

Node 22.21+, Docker for Postgres, and Rust for v8-exec ([docs/operations/README.md](docs/operations/README.md#develop)).

```sh
docker run -d --name agent-runtime-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
npm ci
npm run build:v8-exec     # once, and again after changing sandbox/v8-exec; the runtime-server suites need it
npm run typecheck
```

- **One file alone** (the way to iterate on a change). Each test file gets its own schema in that database
  (`AGENT_TEST_DATABASE_URL` overrides `postgres://postgres:test@127.0.0.1:55432/postgres`):

  ```sh
  node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.ts
  AGENT_HOSTING=inline node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/<file>.test.ts
  ```

  Suites that start a server (`tests/runtime-server.ts`) need Postgres and the v8-exec build above; main CI runs every
  file in both hosting modes (`process`, the default, and `inline`); PRs use `process`.
- **Everything**: `npm test` (and `AGENT_HOSTING=inline npm test`), `npm run test:ui`, `npm run test:python`.
  After changing `/v1` routes, `npm run openapi` (tests/openapi.test.ts fails when openapi.json is stale).
- **Off the laptop, and fanned out**: everything heavier than reading and editing runs on the team's Fly.io Sprites
  pool, several jobs at once, where Postgres, node_modules and the v8-exec build are kept warm. See
  [Off the laptop](#off-the-laptop).
- **CI costs money; spend it once.** Every push to a ready PR runs affected tests on paid runners, and CI has cost
  more than the AI it tests. So:
  - Run the files your change touches locally first (above), plus `npm run typecheck`. Run the full suite before you
    push a change that reaches widely.
  - `npm run test:affected` runs import-selected tests plus smoke tests in process mode against the merge base with `origin/main`.
  - Push when the change is ready: batch fixes into one push, never push to "see what CI says", and rebase once
    rather than on every main commit.
  - Iterate on a draft PR (a draft runs only the fast checks and its changed test files); mark it ready once it
    passes locally. A red CI run means read its log and fix locally, not push again and hope.
  - Don't rerun a failed job to get it green; a flaky test is fixed
    ([docs/operations/README.md](docs/operations/README.md#ci-and-deploys)).

- Release notes in `docs/operations/unreleased/` are gathered elsewhere: no relative links in them (write the path in backticks). After any docs change run `npm run docs` and `node --experimental-strip-types --test --test-name-pattern="llms.txt" tests/docs.test.ts`.

## Off the laptop

The laptop is for reading, editing and a fast loop you are driving. Everything heavier goes to the sprites, in parallel
when the work splits: the full suite, `npm run test:affected`, `npm run typecheck`, `npm run build` and
`npm run build:console`, `npm run openapi`, `npm run docs`, `npm run test:ui`, `npm run test:python`, `npm run bench:*`,
`npm ci`, and any test file that wants Postgres. A single file takes about 20 seconds on a warm sprite, so it is
usually cheaper there than a local Postgres and a local v8-exec build; keep the laptop for the edit-and-rerun loop
while you are in it.

```sh
scripts/sprite-test                                     # the full suite at HEAD, sharded over 8 sprites (8-10 minutes)
scripts/sprite-test origin/main npm test                 # any command, at a ref
scripts/sprite-test HEAD bash -lc 'npm run -s typecheck && npm run -s openapi'
scripts/sprite-test --dirty HEAD npm run build:console   # the working tree you have not committed (no secrets)
scripts/sprite-test --status                            # who holds which sprite, and the commit each has
scripts/sprite-test --warm                              # prepare every free sprite at HEAD, so the next runs start at once
```

Every invocation leases its own sprite through the coordinator, renews the lease every minute and releases it at the
end, so fan out by starting several and waiting on them: typecheck, build and the tests you touch, each on its own
sprite, cost one script run's worth of waiting instead of three.

```sh
scripts/sprite-test HEAD npm run typecheck &
scripts/sprite-test HEAD npm run build &
scripts/sprite-test HEAD node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/api.test.ts &
wait
```

A run gets the committed tree at the ref, put together with `git archive`: never the working directory, so `.env` and
ignored files stay on the laptop. Commit before a run that matters, and before pushing; `--dirty` sends the working
tree you have not committed (untracked files too; `.gitignore` applies) as a temporary commit, which is enough for a
build or a test of work in progress, and never sends secrets: changes to `.env*`, `.dev.vars*`, keys, `*.tfvars` or
credentials files stay on the laptop even when nothing ignores them, and the run lists them. `scripts/sprite-test` is
only this repo's configuration; the machinery is `scripts/sprite-test-core.sh`, a copy of the core camel-bots
keeps too (change both). Options, leases, sync, retries and
exit codes: `scripts/sprite-test --help`, the core's header and the `sprites-agent-runtime` skill.

## Continuing the camel-fs and Workers work

Most active work is not on main. Start here when you pick it up on a fresh machine.

**Branches**
- `camelfs/files-model`: the integration branch for camel-fs (repos, refs, files, VMs) and the Workers backend.
  Branch from it, open PRs against it, and merge only when every check is green on the exact head. It is ahead
  of `main`, where it last merged in #1157.
- `main`: production (the Node backend at run.camelai.com).
- Lanes use prefixes like `camelfs/*`, `pgq/*`, `claude/*`. A branch with no open PR is not work in progress.

**Read first, in this order**
1. `docs/design/camel-fs.md`, then `camel-fs-files.md` and `camel-fs-compute.md`: the target architecture.
   camelRun keeps agents and money; camel-fs (`camelfsd/`, one Go service on AWS plus Firecracker hosts) keeps
   repos, refs (DynamoDB), objects (S3) and VMs; camel-bots keeps Discord audio.
2. `docs/design/camel-fs-v0-limitations.md`: the ledger. Every known limitation is a row (L1 and up) with an owner
   and a status. Its open rows are the backlog. A PR that fixes a row is followed by a ledger PR that closes it
   with measured numbers; a residual becomes a new row.
3. `camelfsd/README.md` and `infra/camelfs/README.md`: the daemon, the tier's AWS resources, and how it deploys.
4. `backends/workers/README.md`: the Workers runtime and the pilot (`run-pilot.camelai.dev`, no external users).
5. `docs/design/roadmap.md`: the plan. The tracks, their next items, what gets simpler after v0, and the order.

**Where it stands (2026-11-16)**
- The camel-fs tier serves the pilot: refs in DynamoDB (#1204 guards ref writes with deletion stamps), VMs on
  a Firecracker host, guest image chosen by `GUEST_IMAGE_SHA256` in `backends/workers/wrangler.pilot.jsonc`.
- File tools read and write committed workspace versions, and successful Bash calls publish their checkpoint
  before returning (#1208, #1211). The host keeps local reflink images and normal starts share clean prebuilt
  ext4 artifacts for an exact lineage, Git tree, disk size and recipe. An absent descriptor builds synchronously
  from verified canonical files. Storage and integrity failures fail the start. Shared workspace-root and chunk
  replication remain retired; the new images are disposable derivatives of Git files.
- L131/L132 track cold-restore performance, and L133 records the earlier cost of removing shared images.
  The Firecracker daemon restart drill preserved the running VM, reattached its command, and reconciled
  its checkpoint and usage. See `camelfsd/README.md` for the deployed build and measurements.
- The pilot uses Firecracker for managed Bash. The legacy Cloudflare class and application are retired
  (#1210, #1212). The unused `CAMELFS_API_TOKEN` secret was removed from the pilot (L30).
- The pilot passed the OpenAI Realtime browser and private Discord voice canaries. See
  `backends/workers/PILOT.md` for the decoded audio results and billing checks.
- The tier measured 69.6 ms p50 per ref write after #1204 (L89). The 50 ms target remains open.

**Doing the work**
- Tests run on sprites (see "Off the laptop"), not on your machine. For any `camelfsd/internal/refstore` change,
  the gate is the camelfsd Go suite with DynamoDB Local (zero skips) plus `tests/camelfs-contract.test.ts` and
  `tests/camelfs-refs-tier.ts`; local runs skip the DynamoDB tests.
- Deploy entry points: `node backends/workers/scripts/pilot-deploy.mjs` (pilot; `--dry-run` first),
  `infra/camelfs/deploy.sh` (the tier's image) and `infra/camelfs/apply.sh` (its settings; plan with
  `PLAN_ONLY=1`). A new guest image is added to `guest_images` (keep the old one), rolled to the host with
  `infra/job-hosts/kvm/host-setup.sh`, then flipped in the pilot's config. `scripts/smoke-compute.ts` checks
  the whole path. Use AWS and Cloudflare credentials scoped to the deployment environment.

## Where things are written down

- [docs/operations/README.md](docs/operations/README.md): layout, local development, CI and deploys, and the index
  of the operations docs (architecture, configuration, persistence, sandbox, isolation, billing, self-hosting).
- [docs/](docs/README.md): the product docs as users read them (also served as llms.txt); `docs/reference/` for the API.
- [CONTRIBUTING.md](CONTRIBUTING.md): the CLA and licenses (only permissive production dependencies).
- `docs/operations/unreleased/`: a note per user-visible change, gathered into release notes at a release.

## Conventions that matter

- **Pi is vendored** (`vendor/pi/`, built from one commit of Pi's main): bump it with `scripts/vendor-pi.sh <sha>`, never by
  editing the tarballs or installing it from npm ([docs/operations/pi-vendoring.md](docs/operations/pi-vendoring.md)).
- **Migrations** (`migrations/NNN_name.sql`, applied at startup): take the next free number on origin/main when you
  merge, and check again after rebasing.
- **Never print a secret**: no tokens, keys or `.env` values in output, logs, tests, commits or PR text.
- **Deployment scope**: Pilot and integration work covers the pilot resources and `camelfs/files-model`.
- Code and docs here are written plainly: short sentences, the facts and the numbers. Match the file you are in.
