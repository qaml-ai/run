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
only this repo's configuration; the machinery is the shared core in the sprites skill
(`~/.agents/skills/sprites/scripts/sprite-test-core.sh`), which camel-bots runs too. Options, leases, sync, retries and
exit codes: `scripts/sprite-test --help`, the core's header and the `sprites-agent-runtime` skill.

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
- **Production changes go through a human**: no applies, restores or writes against production from an agent.
- Code and docs here are written plainly: short sentences, the facts and the numbers. Match the file you are in.
