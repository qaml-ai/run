# Working in camelRun (for coding agents)

camelRun (qaml-ai/run) is the agent runtime behind https://run.camelai.com: a Node.js server that runs each agent's
model loop, keeps its history and files in Postgres and object storage, and runs js_exec on v8-exec (`sandbox/`).
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

## Where things are written down

- [docs/operations/README.md](docs/operations/README.md): layout, local development, CI and deploys, and the index
  of the operations docs (architecture, configuration, persistence, sandbox, isolation, billing, self-hosting).
- [docs/](docs/README.md): the product docs as users read them (also served as llms.txt); `docs/reference/` for the API.
- [CONTRIBUTING.md](CONTRIBUTING.md): the CLA and licenses (only permissive production dependencies).
- `docs/operations/unreleased/`: a note per user-visible change, gathered into release notes at a release.

## Conventions that matter

- **Migrations** (`migrations/NNN_name.sql`, applied at startup): take the next free number on origin/main when you
  merge, and check again after rebasing.
- **Never print a secret**: no tokens, keys or `.env` values in output, logs, tests, commits or PR text.
- **Production changes go through a human**: no applies, restores or writes against production from an agent.
- Code and docs here are written plainly: short sentences, the facts and the numbers. Match the file you are in.
