# Prebuilt images on normal VM starts

The native qualification drives the ordinary `Host` and `image.Manager` startup paths. Its canonical control disables the cache through the test configuration; the normal `camelfsd host` command always enables it. Each successful session verifies every regular file, the exact regular-file count and, after checkpoint recovery, executable mode and symlink target.

The pilot host is an `m8id.xlarge`; each VM uses 2 vCPU and 2048 MiB RAM. Every workspace disk is 64 GiB, matching the serving unit, for a one-file 4 KiB fixture and 49.0625/499.0625 MiB data fixtures. The bare daemon command defaults to a 1024 MiB workspace disk unless configured by its serving unit. The frozen runner pins and verifies the guest image and kernel digests.

Measured results are in [results.md](results.md), with each timed startup in [phases.csv](phases.csv) and its boot/cache/checkpoint stages in [results.json](results.json). The separate [normal-CLI canary summary](raw/20261117T182347Z-76f13612/public-summary.json) records two successful Bash sessions, checkpoint/API-add recovery, settled compute usage and scoped cleanup. Native maintenance first restored the prior binary; the subsequent normal-CLI install retained the qualified candidate, active and healthy, as recorded by the final public receipts.

## Check the captured result

Run from this directory:

```sh
python3 summarize.py raw/20261117T182347Z-76f13612 --output . --check
```

Omit `--check` to regenerate the three outputs. The parser requires both complete 35-start rounds, matching canonical versions and actual 64 GiB disks, expected local/build/remote cache behavior, boot and checkpoint receipts, both corrupt-image refusals, exact fixture cleanup and a healthy restored host with all slots free. Paths are relative to this directory, so a different checkout can check the same captured files.

## Repeat the qualification

The measured source revision is recorded inside the raw log archive, together with the qualification binary's SHA256. Build that revision on the repository's Sprite lane. From `camelfsd`, the native test binary is built with:

```sh
CGO_ENABLED=1 go test -c \
  -tags 'kvm netgo osusergo sqlite_omit_load_extension' \
  -ldflags '-linkmode external -extldflags -static' \
  -o kvm-qualification ./internal/computehost
```

The runtime prerequisites are `/dev/kvm`, `/dev/net/tun`, Firecracker, the pinned guest image/kernel, XFS with reflinks, scoped S3/DynamoDB access and an idle host with its serving daemon stopped and no active VM scopes, TAPs or workspace mounts. The captured run checked these conditions and restored the original serving binary afterward.

For each round, use a fresh work directory and S3 prefix. The fixture creates its own lineage IDs and locator rows. Run the same binary with `canonical-first` and then `prebuilt-first`:

```sh
export CAMELFSD_KVM=1 CAMELFSD_KVM_PREBUILT=1
export CAMELFSD_KVM_COLD_MB=50,500
export CAMELFSD_KVM_PREBUILT_ORDER=canonical-first
export CAMELFSD_KVM_STORE=s3://BUCKET/UNIQUE_PREFIX/round-1/
export CAMELFSD_KVM_OBJECTS_TABLE=OBJECTS_TABLE
export CAMELFSD_KVM_WORK=/nvme/UNIQUE_RUN/work
export GUEST_IMAGE=/path/to/pinned.ext4
export GUEST_KERNEL=/path/to/pinned-vmlinux
./kvm-qualification \
  -test.run '^TestKVMPrebuiltSessionQualification$' \
  -test.v -test.count=1 -test.timeout=45m
```

The experimental `CAMELFSD_KVM_CLEAN_IMAGE`, `CAMELFSD_KVM_IMAGE_RANGES`, `CAMELFSD_KVM_PACKED_APPLY`, `CAMELFSD_KVM_PACKED_PARALLEL` and `CAMELFSD_KVM_MEDIUM_BUNDLES` variables are unset for this qualification. The qualification uses sparse image format 2 and the existing 64 KiB small-blob bundle format. Its maintenance wrapper removed current objects from the captured fixture's S3 prefixes and deleted its locator rows after both rounds; those cleanup receipts accompany the logs.

## Measurement limits

- The timer starts after the host serving process is ready; process initialization, including the canonical control's blank-image creation, precedes it. The test measures VM startup from a ready host.
- Both rounds used one physical host. Fresh process/data directories model empty host-local caches; the hardware, operating-system caches and S3 endpoint were shared.
- The tiny fixture contains one random 4 KiB file. The larger fixtures contain random bytes: 10,000 × 4 KiB small files and 10 or 460 × 1 MiB binaries. The nominal size labels are 50/500 MiB; the JSON records exact logical bytes and workspace virtual disk sizes.
- Each arm/phase has two observations, in reversed order. Tables report medians; individual records retain the variation.
- Each newly built tree pays synchronous materialization, image build and upload. That work is inside first-read time. API-edit/add measurements start after the canonical API commit exists, use fresh host directories and exclude API write latency; they do not time a retained local ancestor.
- Checkpoint startup time is separate from the changed/no-op checkpoint RPCs. Their reported host stages are retained separately.
- The native run does not qualify live multipart images over 5 GiB or first misses with nearly 8 GiB of logical files. Multipart request/abort behavior has mock-S3 coverage.

The [historical dense-format results](historical/dense-v1/README.md) retain the earlier smaller-disk subset and its failed 64 GiB public canary, rollback and cleanup receipts.
