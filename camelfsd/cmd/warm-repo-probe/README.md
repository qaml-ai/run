# Warm Git service experiment

This benchmark-only command prepares a bare Git repository from one pinned
camelFS commit and serves read-only paths and complete snapshots from local Git
objects. Successful preparation verifies the canonical commit, tree, all blob
hashes, modes and sizes. The server rebuilds its path index using `git ls-tree`.
It uses `git cat-file` for reads. The selected service reports unavailable,
missing and corrupt data as errors.

The fixture matches the Firecracker cold-start benchmark. Labels 50 and 500
contain 10,000 random 4 KiB source files and 10 or 460 random 1 MiB assets.
Actual payload sizes are 49.0625 and 499.0625 MiB. Each fixture has unique bytes.

```sh
go test ./cmd/warm-repo-probe
go build -o warm-repo-probe ./cmd/warm-repo-probe
./warm-repo-probe seed --mib 50 --data /tmp/warm-seed
./warm-repo-probe fill --manifest /tmp/warm-seed/manifest.json \
  --store /tmp/warm-seed/canonical --data /tmp/warm-prepared
WARM_REPO_TOKEN=fixture-token ./warm-repo-probe serve --data /tmp/warm-prepared
WARM_REPO_TOKEN=fixture-token ./warm-repo-probe client \
  --manifest /tmp/warm-seed/manifest.json --url http://SERVER:8080
```

`fill` also accepts an S3 source and `--objects-table`. A trusted manifest can
come from the corresponding Firecracker fixture. It must name the exact
canonical lineage, commit, tree and flattened entries. Preparation fetches
small-file bundles once and uses bounded file-backed reads for loose blobs.
The fixture's small-file working set is approximately 39 MiB. This experiment
keeps the fetched small-file packs in memory during preparation.

`client` measures a verified 4 KiB path read, 32 sequential path reads and three
complete verified snapshot transfers. Snapshot `firstEntryMs` is the first
sorted archive entry, `assets/a0000.bin`. The client checks every file against
the pinned manifest, rejects missing, duplicate and corrupt entries, and reads
through HTTP EOF. The archive preserves Git modes using PAX records. Symlink
payloads remain their exact Git blob bytes.

`scripts/warm-repo-pair.sh` runs as two leased Sprite jobs with roles 1 and 2.
The server prepares both sizes and serves on port 8080. The client takes the
server's HTTPS origin and obtains the synthetic fixture manifest before timing.
Readiness polling happens before the benchmark. Selected benchmark requests
run once and report errors. The owner restores the server Sprite's prior URL
authentication and writes `work/warmrepo-results/STOP` after the client finishes.
The server then closes and removes its synthetic source and prepared Git data.
Both jobs collect only their executable, manifests, counts and measurement logs.

These measurements cover repository preparation, service API reads, Git reads,
network transfer and client hash verification. Firecracker startup, guest
application, ext4 writes, ref updates, leases, replication, service failover and
durability after a new write require separate evidence. Local-source fill is
labeled separately from S3 fill. The service is warm after preparation and the
first timing includes a fresh client connection, while subsequent calls reuse
the connection and kernel page cache.
