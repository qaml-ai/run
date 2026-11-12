# camelfsd

A Linux host storage daemon promoted from `prototypes/block/lazyblk`. It stores sparse ext4 images as content-addressed 256 KiB chunks, reflinks warm images, serves cold origins over read-only NBD, and publishes checkpoints with fenced SQLite refs. It never mounts or parses guest filesystems. `tree` is an optional 40-character Git tree SHA; unit 1 preserves it without interpreting it.

Build with Go 1.24+, a C compiler (SQLite), and Linux headers: `go build -o camelfsd ./cmd/camelfsd`. Run `go test ./...` and `go vet ./...`. The daemon requires FICLONE support under `--data` (XFS reflink on the target host). Clone mode also needs loaded NBD/dm-clone modules, `nbd-client`, `losetup`, `dmsetup`, and root privileges. It changes only its own devices. Do not attach guest writers during checkpoint; the caller must freeze or unmount the guest filesystem first.

```sh
./camelfsd host --socket /run/camelfsd/api.sock --data /nvme/camelfs \
  --store s3://bucket/prefix --region us-west-2 --cold clone
./camelfsd client --socket /run/camelfsd/api.sock import-image --lineage test --name main --path /nvme/base.img
./camelfsd client --socket /run/camelfsd/api.sock mount --job j1 --lineage test --ref main
./camelfsd client --socket /run/camelfsd/api.sock checkpoint --job j1
./camelfsd client --socket /run/camelfsd/api.sock status --job j1
./camelfsd client --socket /run/camelfsd/api.sock release --job j1
./camelfsd version
```

`--store /absolute/directory` substitutes a local store. S3 uses the SDK default credential chain. Objects are `c/<sha256>` (chunks), `r/<sha256>` (canonical roots), and `o/<sha1>` (reserved blobs). `--cold prehydrate` downloads all chunks with 16 workers and returns a complete warm image. Default clone mode returns `/dev/mapper/camelfs-<jobId>` immediately; `--hydrate` enables background hydration. `--nbd-listen` defaults to `127.0.0.1:10809`; `--prefetch-depth` defaults to 4. One listener serves all root exports. Keep this listener private to the host.

The HTTP/1.1 JSON API is restricted by a mode-0600 Unix socket. Examples use shell variables `S=/run/camelfsd/api.sock`, `R=<64-hex-root>` and `T=<40-hex-tree>`:

| Method and route | Meaning and example |
|---|---|
| `GET /v0/health` | Configuration and host identity. `curl --unix-socket "$S" http://localhost/v0/health` |
| `POST /v0/images` | Import a local image and CAS a ref; optional `tree` also records a tree/root mapping. Returns root, tree, chunk counts and importMs. `curl --unix-socket "$S" -d "{\"lineage\":\"test\",\"name\":\"main\",\"path\":\"/nvme/base.img\",\"tree\":\"$T\"}" http://localhost/v0/images` |
| `POST /v0/mounts` | Exactly one of ref, root, tree. Ref mounts acquire a five-minute renewable lease. `curl --unix-socket "$S" -d '{"jobId":"j1","lineage":"test","ref":"main","hydrate":true}' http://localhost/v0/mounts` |
| `POST /v0/mounts` (root) | Read-only, lease-less mount; checkpoint is fenced. `curl --unix-socket "$S" -d "{\"jobId\":\"r1\",\"lineage\":\"test\",\"root\":\"$R\"}" http://localhost/v0/mounts` |
| `POST /v0/mounts` (tree) | Resolve newest root in `tree_roots` for this lineage/tree; create or reuse ref `job/<jobId>`, owner `job:<jobId>`, and lease it. Missing mapping returns 404 `no-root-for-tree`. `curl --unix-socket "$S" -d "{\"jobId\":\"t1\",\"lineage\":\"test\",\"tree\":\"$T\"}" http://localhost/v0/mounts` |
| `GET /v0/mounts/:jobId` | State, image, root, hydration region counts and leaseEpoch. `curl --unix-socket "$S" http://localhost/v0/mounts/j1` |
| `POST /v0/mounts/:jobId/checkpoint` | Publish a root, fenced CAS, cache complete snapshot and record the tree/root mapping. Returns root, tree, parentRoot, changedChunks, uploadedChunks, changedBytes and step timings. `curl --unix-socket "$S" -d '{}' http://localhost/v0/mounts/j1/checkpoint` |
| `DELETE /v0/mounts/:jobId` | Detach devices, remove mount files, release lease; returns released/promoted. `curl --unix-socket "$S" -X DELETE http://localhost/v0/mounts/j1` |
| `POST /v0/trees` | 501 `unit 2`. `curl --unix-socket "$S" -d '{}' http://localhost/v0/trees` |
| `PUT /v0/blobs/:sha256` | 501 `unit 2`. `curl --unix-socket "$S" -X PUT -d '{}' "http://localhost/v0/blobs/$R"` |

Errors are JSON `{error, detail}`; a missing lease or failed CAS returns 409 `fenced`. The client prints the response and exits 1 for non-2xx. Import paths must resolve beneath `--data`, `/nvme`, or a repeatable `--import-allow /absolute/dir`; symlinks are resolved. Job IDs match `[A-Za-z0-9._:-]{1,64}` except `.` and `..`. Mount responses include image, warm, root, tree, mountMs and hydrating; `vsock` is accepted for later units.

Checkpoint syncs the destination and reflinks a snapshot. **FIEMAP correction:** reflinking makes the snapshot share with the source, so private extents must be collected on the source *before* reflinking; the snapshot is also FIEMAPed with sync, then those ranges are hashed from it. Holes are included to detect zeroed/punched-out parent chunks. Timings include both FIEMAP walks. Cold checkpoint first waits for complete hydration (up to five minutes) and suspends dm-clone while snapshotting; this avoids publishing an incomplete destination. Release promotes a hydrated origin only after verifying it still matches its root; edited destinations are promoted by checkpoint under their new root.

State lives in `images/`, `mounts/<jobId>/state.json`, `cache/<aa>/<hash>`, and `refs.db`. A data-directory lock prevents concurrent daemons. Graceful SIGTERM releases mounts. Startup refuses leftover mount state after a crash: stop guest users and manually detach the devices recorded in state before removing that mount directory. Automatic recovery is a later unit.

For unprivileged tests only, `CAMELFSD_TEST_NO_REFLINK=1` skips the probe, copies instead of reflinking and hashes the whole image during checkpoint; a log line identifies this mode. Root-mount file permissions are read-only; privileged consumers must honor that contract. Run `sudo scripts/ec2-smoke.sh clone` and `sudo scripts/ec2-smoke.sh prehydrate` only after the host availability gate. The script writes its report under `/nvme/camelfs/`, uses a fresh S3 prefix, verifies round trips and cleans up its devices. S3 objects remain for inspection.
