# Workspace delivery experiments

These are the November 17, 2026 workspace delivery prototypes and their measured
results. Normal daemon starts retain canonical parallel restore and the 64 KiB
bundle cutoff. Prepared apply is an explicitly configured image-manager path.
Clean ext4 preparation and restore live in the KVM test fixture. Warm Git is a
standalone benchmark command. The 1 MiB bundle cutoff requires both build tags
`kvm,camelfs_medium_bundles`.

## Results

All 23 native trials passed, covering 69 fresh daemon, cache and VM phases on
the pilot host. Each trial measured an initial version, a committed API edit,
and a committed API addition. Each phase hydrated the complete workspace before
execution and verified the requested content and full file count.

| Random fixture | Canonical | Parallel prepared apply | Parallel clean ext4 | Bulk 1 MiB bundles |
| --- | --- | --- | --- | --- |
| 50 MiB | 2.220 s | 1.822 s | 1.404 s | Unmeasured |
| 500 MiB | 4.901 s | 6.111 s | 3.102 s | 6.488 s |

These medians combine all three phases. Artifact preparation and upload cost
1.283/6.948 s for parallel apply and 2.928/14.682 s for parallel ext4 at
50/500 MiB. Including preparation, every derived artifact increased first-miss
time. Parallel ext4 was fastest when its exact committed tree was already
prepared. A new tree needs a new artifact.

The artificial source fixture improved from 2.303 s to 1.647 s with gzip apply,
plus 0.823 s preparation. Its small files contain repeated source-like text,
and its large files remain random. This is a compressibility test.

A separate warm Git service on two Sprites measured 54–56 ms for a verified
4 KiB file and 0.667/1.557 s for complete 50/500 MiB snapshot transfer. Local
canonical-to-Git preparation cost 3.294/37.809 s. These timings exclude VM boot,
guest apply and ext4 writes. There was no paired current-API control.

[Full results and limitations](results.md), [machine-readable measurements](results.json),
[per-phase CSV](phases.csv), and [warm Git trial](warm-repo-service/results.md)
include preparation costs, phase breakdowns, provenance and cleanup receipts.
The first outer maintenance wrapper exited with a shell parser error after its
12 tests passed. Its EXIT recovery restored the pilot and cleaned its synthetic
data. The archived console retains that error.

## Reproduce native trials

Use the Linux KVM host lane with Firecracker, the guest image and kernel, a
reflink-capable work directory, AWS credentials, and an objects table using the
current locator schema. Give each run an isolated S3 prefix and retain its
printed `coldbench-*` lineage IDs for scoped object and locator cleanup. The
fixture writes synthetic objects to that prefix and table.

From `camelfsd/`, set the shared environment, then select one arm below.

```sh
export CAMELFSD_KVM=1 CAMELFSD_KVM_COLD_MB=50,500
export CAMELFSD_KVM_STORE=s3://YOUR-BUCKET/ISOLATED-BENCHMARK-PREFIX
export CAMELFSD_KVM_OBJECTS_TABLE=YOUR-OBJECTS-TABLE
export CAMELFSD_KVM_WORK=/YOUR-REFLINK-WORK-DIRECTORY
export GUEST_IMAGE=/YOUR-GUEST-IMAGE GUEST_KERNEL=/YOUR-GUEST-KERNEL
export CAMELFSD_KVM_PACKED_APPLY=control

go test -tags kvm ./internal/computehost -run '^TestKVMColdSessionBench$' -count=1 -v
```

| Arm | Additional environment | Build tags |
| --- | --- | --- |
| Canonical control | `CAMELFSD_KVM_PACKED_APPLY=control` | `kvm` |
| Prepared plain | `CAMELFSD_KVM_PACKED_APPLY=plain` | `kvm` |
| Prepared gzip | `CAMELFSD_KVM_PACKED_APPLY=gzip` | `kvm` |
| Parallel prepared plain | `CAMELFSD_KVM_PACKED_APPLY=plain CAMELFSD_KVM_PACKED_PARALLEL=1` | `kvm` |
| Clean ext4 | `CAMELFSD_KVM_PACKED_APPLY=control CAMELFSD_KVM_CLEAN_IMAGE=1` | `kvm` |
| Parallel clean ext4 | `CAMELFSD_KVM_PACKED_APPLY=control CAMELFSD_KVM_CLEAN_IMAGE=1 CAMELFSD_KVM_IMAGE_RANGES=1` | `kvm` |
| Bulk 1 MiB bundles | `CAMELFSD_KVM_PACKED_APPLY=control CAMELFSD_KVM_MEDIUM_BUNDLES=1` | `kvm,camelfs_medium_bundles` |

Start each arm with the other selectors unset. Boolean selectors accept unset,
`0` or `1`. Unsupported values and conflicting selectors fail before fixture
publication. `CAMELFSD_KVM_CONTENT=source` selects the compressible fixture.
Unset content selects random bytes. Leaving `PACKED_APPLY` unset retains the
older cold/warm benchmark rather than the three-phase comparison.

The prepared manifest binds the canonical lineage, commit and tree, the encoded
and decoded digests, and byte/file counts. Restore verifies the exact artifact
before applying it to a blank workspace. Range downloads use 8 MiB requests
with 32 workers. A selected arm fails on missing or corrupt artifacts. The
fixture supplies trusted manifests. Automated publication, retention and reuse
across normal daemon lifecycles would require additional implementation.

The medium arm stages all synthetic assets in one bulk publication. The
interleaved 272 MiB regression deliberately crosses bounded apply windows and
checks ordered content and fetched-byte counts across the 256 MiB apply window.
Ordered checkpoint spool windows may have different pack locality. Run it on a Sprite without KVM devices using
`go test -tags kvm,camelfs_medium_bundles ./internal/image -run Medium -count=1 -v`.

## Warm Git and evidence checks

[Warm Git command instructions](../../cmd/warm-repo-probe/README.md) cover
`seed`, `fill`, `serve`, `client` and the two-Sprite script.

The archived evidence is self-contained. Python uses only its standard library.
Check all 69 phases, terminal test results, revision and binary provenance,
restoration receipts, computed aggregates and input checksums with

```sh
python3 camelfsd/benchmarks/workspace-delivery/aggregate.py --check
```

Run without `--check` to regenerate the reports from the archived inputs.
Measurements name the original tested revisions. The combined branch adds
strict option validation, a separate medium build tag and script cleanup fixes.
The numerical results remain those recorded on the original prototypes.
