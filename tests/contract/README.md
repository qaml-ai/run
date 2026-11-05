# Public runtime contract

These cases use the public HTTP API and the repository's TypeScript and Python
SDKs. Fixtures own backend startup, isolated test schemas/databases, synthetic
credentials, scripted HTTP providers, and test-only recovery setup. Assertions
remain the same on Node and Workers. Original implementation tests stay in
`tests/`.

## Run on the Sprite pool

Run from a committed tree. The default is six leased Sprites, with two Workers
files or six Node files per Sprite. `scripts/sprite-test` handles leases, checkout sync, Postgres,
root dependencies, and the v8-exec build. Contract setup also caches Workers
node_modules and a private Python environment by dependency inputs.

```sh
npm run parity
npm run parity -- --backend=node
npm run parity -- --backend=workers
npm run parity -- --backend=workers --area=history
npm run parity -- --backend=workers --group=delegation --shards=3
npm run parity -- --list
```

`both` (the default) requires a green Node baseline before running Workers.
`workers` never starts Node: it requires matching cached evidence for every
selected case and reports a missing baseline as an error. A full baseline serves
any area or group subset. Area, group, and file filters intersect; shards keep
whole files together. File weights come from the checked-in Node baseline, and
assignment, merged rows, and raw-log order are deterministic.

Use `CONTRACT_SPRITES` or `--shards=N` to change the pool size.
`CONTRACT_CONCURRENCY` controls files per Sprite (Workers default two, Node six,
maximum sixteen). The lower Workers limit keeps wrangler's build and workerd
processes within each Sprite's memory budget.
Every Node fixture owns a random schema; every Workers fixture owns a random
Postgres database and workerd directory. `serialFiles` in `groups.mjs` records
exceptions and their reasons; there are currently none.
The Python file runs two Workers or four Node case subprocesses on its assigned Sprite;
`CONTRACT_PYTHON_CONCURRENCY` changes that limit. Its file is never split across
Sprites, and every subprocess runs an original unittest case unchanged.

## Groups

`groups.mjs` is the only mapping. File overrides take precedence over areas;
unmatched cases remain in `other`. List a group's exact inventory with
`npm run parity -- --list --group=NAME`.

```sh
npm run parity -- --backend=workers --group=delegation
npm run parity -- --backend=workers --group=tools-mcp
npm run parity -- --backend=workers --group=configuration
npm run parity -- --backend=workers --group=files-attachments
npm run parity -- --backend=workers --group=models-routing
npm run parity -- --backend=workers --group=accounts-auth
npm run parity -- --backend=workers --group=webhooks
npm run parity -- --backend=workers --group=lifecycle
npm run parity -- --backend=workers --group=billing
npm run parity -- --backend=workers --group=other
```

## Baselines and timeouts

Green Node reports are stored by SHA-256 key in
`backends/workers/measurements/node-baselines/` and, on each Sprite, under
`~/rt-cache/contract/node-baselines/`. Commit the baseline for the integration
state so another developer's Workers-only run can reuse it. The pool runner also
sends locally generated baseline reports to its leased Sprites.

The Node key covers runtime source/data, SDKs, imported local packages and
helpers, vendored dependencies, migrations, sandbox source, served docs/OpenAPI,
contract cases/fixtures, and dependency lockfiles. Workers application code,
Workers dependencies, and the Workers-only fixture do not change that key.
Reports also carry a separate suite hash covering Workers inputs; merging
rejects stale, duplicate, missing, or unexpected results.

Node keeps its 90-second default. Every explicit original case/poll timeout is
preserved. For cases with no explicit timeout, Workers uses three times that
case's observed Node p99 duration, with a 30-second floor for startup/scheduling.
The Node baselines' overall p99 ranged from 23 to 27 seconds. Concurrent Wrangler
startup exhausted the first 10-second floor before assertions began; the
30-second floor includes that setup. Explicit case and polling timeouts stay
unchanged.
One baseline observation is one sample; unknown durations retain 90 seconds.
`CONTRACT_TIMEOUT_MS` overrides the default when explicitly supplied.
Unsatisfied polls fail immediately on a required route returning 404, 405, 501,
or an explicit unsupported body. A predicate which expects that status still
succeeds. Request-state waits also reject incompatible terminal states, and
closed event streams cannot wait forever for another event.

The measured full comparison fell from 43m 22s on one Sprite to 14m 35s on six,
including a Node shard retry. The cached Workers phase took 9m 22s; the
Workers-only delegation group took 1m 49s. All 590 in-scope case statuses were
unchanged. See [timing and result evidence](../../backends/workers/measurements/parity-speed.md).

## Reports and local debugging

Full comparisons write `backends/workers/PARITY.md`, merged JSON reports and raw
logs in `backends/workers/measurements/`. Filtered runs have a suffix and leave the
full scorecard intact. Raw shard artifacts and wall-clock metadata are kept in
ignored `backends/workers/measurements/runs/`. Failures, missing results, and
process cleanup failures remain failures. SDK-only cases never increase the
backend HTTP pass count; channel and voice/audio cases are out of scope.

For an already prepared machine or Sprite:

```sh
npm run parity -- --local --backend=node --area=history
npm run parity -- --local --backend=workers --area=history
node tests/contract/check-assertions.mjs
node tests/contract/check-product-assertions.mjs
```

Local runs need root and Workers dependencies, Python requirements, v8-exec, and
loopback Postgres. `AGENT_TEST_DATABASE_URL` overrides the default Node port
55432 or Workers port 55434. Fixtures reject non-loopback database addresses.
`bash tests/contract/validate-node.sh --compare` runs typechecking, assertion
checks, docs checks, then both backends on one prepared Sprite.

The local-only `backends/workers/test/contract-entry.ts` supplies synthetic
operator identities and seeds persisted state. The original Worker handles
requests, model turns, alarms, storage, auth and billing. No production
credentials or cloud deployment are used. `COVERAGE.md` describes source mapping
and the remaining implementation-specific observations.
