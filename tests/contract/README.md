# Public runtime contract

These cases use the public HTTP API and the repository's TypeScript and Python
SDKs. The fixtures own backend startup, an isolated test database, synthetic
tenant credentials, scripted HTTP providers, and test-only time/recovery setup.
Case bodies do not instantiate a Node runtime service. Original implementation
tests remain in `tests/`.

Install the root dependencies and `backends/workers` dependencies. Node needs the
normal `v8-exec` build. Both fixtures require local Postgres with permission to
create test schemas/databases; they reject non-loopback database addresses.

```sh
npm run parity
npm run parity -- --area=history
npm run parity -- --backend=node --area=history
npm run parity -- --backend=workers --area=history
npm run parity -- --list
node tests/contract/check-assertions.mjs
node tests/contract/check-product-assertions.mjs
```

`AGENT_TEST_DATABASE_URL` selects Postgres. Node defaults to port 55432 and
Workers to 55434. Set it explicitly when comparing backends. `CONTRACT_CONCURRENCY`
controls parallel test files (Node defaults to two, Workers to one).
The Sprite validation script uses four files at a time. Install Python test
dependencies with `python3 -m pip install -r clients/python/requirements.txt`.
`CONTRACT_TIMEOUT_MS` controls case timeouts; the default is 90 seconds. A case
which needs more time keeps its explicit original timeout.

For the Node baseline off the laptop, run the committed tree on Sprites in the
background and poll its log:

```sh
scripts/sprite-test HEAD bash tests/contract/validate-node.sh > /tmp/parity-node.log 2>&1 &
tail -f /tmp/parity-node.log
```

Sprites receives a Git archive. `CONTRACT_REVISION` can carry its commit ID;
without it, the content hash still identifies every tested source and fixture.
The resulting report is under `~/rt/backends/workers/measurements/` on that Sprite.
Copy `parity-node.json` back before a local Workers run. Installing Workers
dependencies on the Sprite also allows running both backends there.

`npm run parity` runs Node first and refuses to run Workers unless every selected
Node case is green. A Workers-only run requires a Node report for the same area,
complete case inventory, source content hash, and fixture content hash. The
reporter records assertion failures, missing results and process cleanup failures.
A pure SDK test is labeled `sdk-unit`; it never increases the backend pass count.
Channel and voice/audio cases are inventoried as `out-of-scope`, never passes.

Full comparisons regenerate `backends/workers/PARITY.md` and the two JSON/log
artifacts in `backends/workers/measurements/`. Area runs have a suffix and do not
overwrite the full scorecard. `COVERAGE.md` describes source mapping and the
remaining implementation-specific observations. Failure details stay in JSON
and raw logs; the Markdown scorecard gives one line per failure.

The Workers entrypoint in `backends/workers/test/contract-entry.ts` is local-only.
It is absent from deployment configuration. It supplies multiple synthetic
operator identities and prepares persisted state; the original Worker handles
the requests, model turns, alarms, storage, authentication and billing policy.
No production credentials or cloud deployment are needed.
