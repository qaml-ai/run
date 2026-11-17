# Historical dense format 1 qualification

These are the earlier source `249e5efc5bbf2b3521cef283d14006f4ae0a6b19` results. Its native 58-start / two-corruption subset passed with 1074/1524 MiB workspace disks. The subsequent normal-CLI canary used the pilot unit's real 64 GiB workspace disk and exposed work proportional to the disk's holes: a tiny tree took 60.173246 seconds to build, 0.810703 seconds to publish and 60.999749 seconds in the helper. The Worker startup request timed out; a retry reached the already-booted VM, then the model turn reported `turn_limit` and the harness ended with `Unexpected end of JSON input`. The installed candidate was rolled back.

This dense-format subset is historical evidence. The current sparse-format qualification uses real 64 GiB disks, including a one-file fixture, and has its own results above this directory.

- [Native report](results.md), [all first-read records](phases.csv), [structured stages and original receipt checksums](results.json).
- [Failed public smoke](raw/20261117T181412Z-249e5efc-public-smoke/public-smoke.jsonl), [install log](raw/20261117T181412Z-249e5efc-public-smoke/install.log), [rollback host receipt](raw/20261117T181412Z-249e5efc-public-smoke/rollback-restored.json).
- [Owned fixture cleanup](raw/20261117T181412Z-249e5efc-public-smoke/failed-smoke-cleanup.json) records deletion of the temporary tenant/agent/token and current S3 objects, removal of its two locators and preservation of the accounting audit. The lineage retains its deletion fence.

The original native report records its smaller virtual disks explicitly. Its timings remain unchanged. The raw log archive contains the exact source and binary digests and both complete native round logs.

Run `sha256sum --check receipts.sha256` from this historical directory to verify its archived files.
