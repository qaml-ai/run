# Contract harness timing

Measured on the camelai Sprite pool on 2026-11-05. Each Sprite had 8 CPUs and
8 GiB RAM. The untouched comparison used `a2d1d6c7`; the final comparison used
`38f8e794`. Neither run changed the Node or Workers application.

| Run | Sprites | Wall time |
| --- | ---: | ---: |
| Before: full Node then Workers | 1 | 2,602 s (43m 22s) |
| After: full Node then Workers | 6 | 874.970 s (14m 35s) |
| After: Node phase | 6 | 313.231 s (5m 13s) |
| After: Workers phase, cached Node | 6 | 561.738 s (9m 22s) |
| Workers-only delegation group | 6 | 109.386 s (1m 49s) |

The full final command was `npm run parity`. Its Workers phase ran only Workers
and printed the reused Node key on all six shards. The group command was
`npm run parity -- --backend=workers --group=delegation`; it ran no Node tests.
These times include pool preparation, dependency setup, artifact collection and
report merging. The Node phase includes one Sprite restart and its shard retry.
The delegation run included initial Workers dependency setup on its Sprites.

Node used six files and four Python cases per Sprite. Workers used two files and
two Python cases. An earlier six-file Workers trial exceeded the Sprite memory
budget; its aborted results are not included in this comparison.

## Exact result comparison

| Backend | Before pass / fail | After pass / fail | Changed case statuses |
| --- | ---: | ---: | ---: |
| Node | 590 / 0 | 590 / 0 | 0 |
| Workers | 121 / 469 | 121 / 469 | 0 |

Both runs have exactly the same 590 in-scope identities and 380 out-of-scope
identities, with no duplicates, missing rows or extra harness failures. The
delegation group's 39 cases remain failures. Four already-failing Workers cases
changed diagnostic classification between HTTP, fixture startup and timeout
failures. No passing case changed classification. These diagnostics are not
evidence that the missing Workers behavior has been implemented.

The audits retained 2,516 assertions in 311 ported cases and 620 assertions in
49 product test declarations. The 21 harness/cancellation regressions, six Python
runner regressions, typecheck and docs checks passed on Sprites.

`parity-speed.json` records the source keys, phase metadata, counts and SHA-256
digests of sorted `[area, source, name, status]` tuples. `parity-node.json` and
`parity-workers.json` contain the full final results. The green Node cache is
`node-baselines/37fe8ceacf3bc0cd00210c288964a3d85119933e53516aa4392d3f40854b56dc.json`.

The untouched remote job saved both reports and its 2,602-second timing before
exiting with the expected assertion failures. Its local driver then reported a
shell parse error because that script had been edited while the run was active;
the saved reports were complete and were used for the identity comparison.

After this paired benchmark, the integration branch advanced to `8db58007` with
Workers implementation changes. The draft incorporates that branch and resolves
the runner/fixture conflicts. Its Node key is still exactly the key above, so
the green Node cache remains valid. The paired results describe the fixed
application revision used for the benchmark, not the newer Workers behavior.
