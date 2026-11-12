# CI on the sprite pool (sprite-ci)

When GitHub Actions is down or stalled, `scripts/sprite-ci.mjs` runs CI's gates for one commit on the sprite pool
(`scripts/sprite-test`, the rt-pool sprites) and posts the result on that commit as a commit status named
`sprite-ci`. It is a fallback for reviewers and for whoever merges: it does not change branch protection, and the
existing workflows stay what they are. A required check that GitHub has not run still blocks a merge, so a merge on a
`sprite-ci` result alone is a deliberate admin decision, not something the status does by itself.

## Running it

From a checkout of the repository, with `gh` signed in and the sprite pool set up (as for `scripts/sprite-test`):

```bash
scripts/sprite-ci.mjs 818                 # PR #818's head: every gate, status posted on the head commit
scripts/sprite-ci.mjs 818 --comment       # also a PR comment with each gate's results; the status links to it
scripts/sprite-ci.mjs 5aa981b8 --gates=workers-unit,workers-integration --no-status
scripts/sprite-ci.mjs --list              # the gates and what each runs
```

- **Target:** a PR number or a commit. For a PR number it reads the head commit with `gh pr view` and fetches
  `pull/<n>/head`. When GitHub is unreachable, fetch the branch some other way and pass its commit instead.
- **Gates:** they run at the same time, each through `scripts/sprite-test` at that commit. The full suite takes 8
  sprites and Workers integration takes 3; the others take one each, so a whole run leases 16 sprites from the pool.
  A run takes about as long as its slowest gate, usually Workers integration's third shard (10 to 25 minutes).
- **Logs:** every gate's log is kept in `~/.cache/sprite-ci/<sha>/<gate>.log` (`--out=DIR` to change it). Each
  sprite also keeps its own log under `~/runs/` (fetch one with `scripts/sprite-test --fetch`).
- **Exit code:** 0 when every gate passed, 1 when any failed, 2 when the run could not start.
- **Options:**
  - `--gates=a,b` runs only some gates;
  - `--no-status` posts nothing;
  - `--context=NAME` posts under another status name.

## The gates

| Gate | What it runs | CI job it stands in for |
|---|---|---|
| `full` | the full Node suite, 8 shards (`scripts/sprite-test` with no command) | `ci.yml` test |
| `workers-unit` | `backends/workers/scripts/validate-sprite.sh unit` | `workers-tests.yml` unit |
| `workers-integration` | `validate-sprite.sh integration i/3`, 3 shards | `workers-tests.yml` integration |
| `checks` | the ECS deploy script test, `npm run typecheck`, `npm run test:ui`, the console and studio builds, Workers `check:reuse` | `ci.yml` checks, and the generated-copies step of `workers-tests.yml` |
| `docs` | CI's own script tests and the docs and OpenAPI tests, the same file list as CI | `ci.yml` docs |
| `sim` | the simulator's fixed seeds 1 to 10, twice each | `ci.yml` sim |
| `python` | the Python SDK tests, in a virtualenv on the sprite | `ci.yml` python |

Not covered:
- the container image build and its publish to ECR (`ci.yml` image and publish);
- the `changes` selection, which narrows CI to the tests a change affects; sprite-ci always runs every gate in full;
- the reuse of a tree CI already tested.

The tests in `tests/sprite-ci.test.ts` check that each Workers gate names a `validate-sprite.sh` mode that exists, and
that the `docs` gate runs CI's file list. When CI gains or changes a required job, add or change its gate in
`GATES` in the script.

## Reading the result

A gate's exit code is its verdict. From its log, the script also takes:
- the TAP totals (`# pass`, `# fail`, `# cancelled`), summed over shards and runs;
- the top-level `not ok` tests;
- each shard's exit line, with its time and sprite.

The full suite retries a failing file once. A test that failed and then passed on that retry leaves the gate passing,
and the summary notes it as `(n retried)`.

The status description is at most 140 characters, GitHub's limit. Failed gates come first:
`1/7 gates failed: workers-integration FAILED 99/2, full 2886/0, ...`.

With `--comment`, a PR comment lists:
- every gate, with its pass/fail counts and each shard's exit, time and sprite;
- every failing test;
- where the logs are.

When the run finishes, the status is posted as `success` or `failure`; it is set to `pending` while it runs. If
`gh` cannot reach GitHub, the script still prints the full report and says the status was not posted.

Each gate's latest result for a commit is kept next to its log (`<gate>.json`), so the report and status always
cover every gate that ran on that commit. For a gate that failed on something outside the change (a flake, a sprite
under load), rerun just that gate with `--gates=<gate>`: the new status combines it with the other gates' earlier
results. The same rerun posts a status GitHub could not take earlier. A rerun marks its gates failed until they
finish, so a rerun cut short never leaves an earlier pass standing.

Known flake: the Workers unit suite sometimes loses a test file to a `SIGSEGV` in Node (the file shows as `not ok`
with `signal: 'SIGSEGV'`; `pilot-migrate.test.ts` and `security-policy.test.ts` have done it). Rerun the gate.

A failure on one sprite that does not reproduce elsewhere is usually load on that sprite, often in the Docker tests.
Before calling it noise, rerun that gate pinned to one sprite (`SPRITE_NAME=rt-pool-30 scripts/sprite-test ...`)
against the base commit as well, and compare the two.
