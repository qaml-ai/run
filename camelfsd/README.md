# camelfsd

A Linux host storage daemon promoted from `prototypes/block/lazyblk`. It stores sparse ext4 images as content-addressed 256 KiB chunks, reflinks warm images, serves cold origins over read-only NBD, and publishes checkpoints with fenced SQLite refs. It never mounts or parses guest filesystems. `tree` is an optional 40-character Git tree SHA; tree imports use Git-exact objects; tree mounts apply file deltas through the guest.

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

`--store /absolute/directory` substitutes a local store. S3 uses the SDK default credential chain. Objects are `p/<packId>` (chunk bytes), `r/<sha256>` (canonical roots), `o/<sha1>` (raw blobs), and `t/<sha1>` (trees over 400 KiB). `--cold prehydrate` downloads packs or contiguous ranges with 64 workers by default and returns a complete warm image. Default clone mode returns `/dev/mapper/camelfs-<dataHash>-<jobId>` immediately; background hydration is on by default (`mount --hydrate=false` or JSON `hydrate:false` opts out). `--nbd-listen` defaults to `127.0.0.1:10809`; `--prefetch-depth` defaults to 64. One listener serves all root exports. Keep this listener private to the host.

The HTTP/1.1 JSON API is restricted by a mode-0600 Unix socket. Examples use shell variables `S=/run/camelfsd/api.sock`, `R=<64-hex-root>` and `T=<40-hex-tree>`:

| Method and route | Meaning and example |
|---|---|
| `GET /v0/health` | Configuration and host identity. `curl --unix-socket "$S" http://localhost/v0/health` |
| `POST /v0/images` | Import a local image and CAS a ref; optional `tree` also records a tree/root mapping. Returns root, tree, chunk counts and importMs. `curl --unix-socket "$S" -d "{\"lineage\":\"test\",\"name\":\"main\",\"path\":\"/nvme/base.img\",\"tree\":\"$T\"}" http://localhost/v0/images` |
| `POST /v0/mounts` | Exactly one of ref, root, tree. Ref mounts acquire a five-minute renewable lease. `curl --unix-socket "$S" -d '{"jobId":"j1","lineage":"test","ref":"main","hydrate":true}' http://localhost/v0/mounts` |
| `POST /v0/mounts` (root) | Read-only, lease-less mount; checkpoint is fenced. `curl --unix-socket "$S" -d "{\"jobId\":\"r1\",\"lineage\":\"test\",\"root\":\"$R\"}" http://localhost/v0/mounts` |
| `POST /v0/mounts` (tree) | Resolve newest root in `tree_roots` for this lineage/tree; create or reuse ref `job/<jobId>`, owner `job:<jobId>`, and lease it. Missing mappings use an ancestor root or the blank image. `curl --unix-socket "$S" -d "{\"jobId\":\"t1\",\"lineage\":\"test\",\"tree\":\"$T\"}" http://localhost/v0/mounts` |
| `GET /v0/mounts/:jobId` | State, image, root, hydration region counts and leaseEpoch. `curl --unix-socket "$S" http://localhost/v0/mounts/j1` |
| `POST /v0/mounts/:jobId/checkpoint` | Publish a root, fenced CAS, cache complete snapshot and record the tree/root mapping. Returns root, tree, parentRoot, changedChunks, uploadedChunks, changedBytes and step timings. `curl --unix-socket "$S" -d '{}' http://localhost/v0/mounts/j1/checkpoint` |
| `DELETE /v0/mounts/:jobId` | Detach devices, remove mount files, release lease; returns released/promoted. `curl --unix-socket "$S" -X DELETE http://localhost/v0/mounts/j1` |
| `POST /v0/trees` | Complete file listing; returns tree, new tree count, blob count and importMs. Missing lineage uploads return 409 with up to 10,000 sorted SHA-256s. `curl --unix-socket "$S" -d '{"lineage":"test","files":{}}' http://localhost/v0/trees` |
| `PUT /v0/blobs/:sha256?lineage=L` | Stream a blob, Content-Length optional (chunked uploads accepted), at most 256 MiB; returns sha256, Git sha1 and size. `curl --unix-socket "$S" -X PUT --data-binary @file "http://localhost/v0/blobs/$R?lineage=test"` |
| `GET /v0/trees/:tree` | Flattened paths, modes, blob SHA-1s and sizes. `curl --unix-socket "$S" "http://localhost/v0/trees/$T"` |
| `GET /v0/trees/:tree/files/*path` | Raw bytes; symlinks return their target with X-Camelfs-Mode: 120000. `curl --unix-socket "$S" "http://localhost/v0/trees/$T/files/src/main.go"` |
| `GET /v0/blobs/:sha1` | Raw blob bytes. `curl --unix-socket "$S" "http://localhost/v0/blobs/$B"` |

Errors are JSON `{error, detail}`; a missing lease or failed CAS returns 409 `fenced`. The client prints the response and exits 1 for non-2xx. Import paths must resolve beneath `--data`, `/nvme`, or a repeatable `--import-allow /absolute/dir`; symlinks are resolved. Job IDs match `[A-Za-z0-9._:-]{1,64}` except `.` and `..`. Mount responses include image, warm, root, tree, mountMs and hydrating; `vsock` selects the two guest stream socket paths.

Checkpoint syncs the destination and reflinks a snapshot. **FIEMAP correction:** reflinking makes the snapshot share with the source, so private extents must be collected on the source *before* reflinking; those ranges are then hashed from the snapshot. Holes are included to detect zeroed/punched-out parent chunks. fiemapMs measures only the live-image walk. Holes are read only where the parent has a stored chunk. Cold checkpoint first waits for complete hydration (up to five minutes, bounded by the request deadline). At completion the status poller briefly suspends dm-clone, reflinks `hydrated.img`, and resumes it. A background comparison hashes parent-root chunk offsets to find early guest writes; private non-root extents are marked changed without hashing holes. Checkpoint waits for that comparison, then hashes those offsets plus FIEMAP private extents since the sharing partner. After publication, the checkpoint snapshot becomes the partner and early writes are cleared. Suspension covers FIEMAP and reflinking only; hashing and publication run after resume. Release never hashes: it promotes `hydrated.img` under the original root only when the completed background comparison found no early writes. Checkpoint promotes edited images under their new roots.

State lives in `images/`, `mounts/<jobId>/state.json`, `cache/<aa>/<hash>`, and `refs.db`. A data-directory lock prevents concurrent daemons. Graceful SIGTERM releases mounts. Startup refuses leftover mount state after a crash: stop guest users and run `camelfsd cleanup --data DIR` to detach recorded devices and remove mount directories. Automatic recovery is a later unit.

For unprivileged tests only, `CAMELFSD_TEST_NO_REFLINK=1` skips the probe, copies instead of reflinking and hashes the whole image during checkpoint; a log line identifies this mode. Root-mount file permissions are read-only; privileged consumers must honor that contract. Run `sudo scripts/ec2-smoke.sh clone` and `sudo scripts/ec2-smoke.sh prehydrate` only after the host availability gate. The script writes its report under `/nvme/camelfs/`, uses a fresh S3 prefix, verifies round trips and cleans up its devices. S3 objects remain for inspection.


Tree import walks directories without following symlinks, skips `.git`, uploads missing blobs with 64 workers by default, and retries the complete listing. Missing results are lineage-scoped even when another lineage already uploaded the bytes. The client reports uploadedBlobs and uploadMs alongside the import result; an unchanged second import uploads zero blobs.

```sh
./camelfsd client --socket "$S" import-tree --lineage test --dir ./project
./camelfsd client --socket "$S" import-tree --lineage test --dir ./project --parent "$T"
./camelfsd client --socket "$S" tree "$T"
./camelfsd client --socket "$S" cat "$T" src/main.go
```

Tree paths are relative and slash-separated, at most 4096 bytes, with no empty, dot, dot-dot, NUL or `.git` segment. Modes are 100644 (default), 100755 and 120000; gitlinks are refused. Listings accept at most 200,000 files and 64 MiB of JSON. Empty directories are dropped. Absent paths are removed; parentTree is only a reuse hint. Imported trees without a tree/root mapping apply from an ancestor or blank image. Trees use Git's header-prefixed SHA-1, exact binary entry encoding and directory sorting rule. SQLite stores small trees inline and large trees as stub rows referencing the store. New tree rows commit together. Set B to a 40-character blob SHA-1 for the raw-blob example above.


The s3speed defaults are 64 concurrent blob/chunk fetches and uploads per host (`host --fetch-depth 64`) and 64 blob uploads per import client (`import-tree --fetch-depth 64`). A shared store budget covers foreground reads, prefetch and hydration. S3 keeps connections alive, with MaxIdleConnsPerHost and MaxConnsPerHost set to the host fetch depth (64 by default). Prefetch lookahead remains separate at `--prefetch-depth 64`. Chunk size stays 256 KiB. Clone hydration is driven exclusively by dm-clone, enabled immediately with batch size 256 and threshold 256. Direct writes to an unmarked destination region would race dm-clone and cannot safely update its bitmap. Demand uses S3 ranges within packs. Prehydrate fetches packs or contiguous ranges with 64 workers and the shared 64-operation store budget. `--hydration-pack-size` (default 4 MiB) bounds local image write windows.

## Tree mounts and guest streams (unit 3)

Tree mounts use the nearest recorded ancestor root (up to 64 parent links), or a
blank ext4 image. `--virtual-size` selects the blank size (default 1 GiB).
At startup the daemon creates `images/blank-<size>.img` using a sparse temporary
file it created exclusively, formats only that file, syncs it and renames it.
It never formats, mounts or walks a guest image. Tree imports record `parentTree`.
The mount response includes `apply: {fromTree,toTree,files,bytes}`, or `null` when
the image already represents the tree. Unmapped roots have an empty index and
empty tree IDs. Ref and root mounts also serve the apply handshake.

Supply `vsock` in the mount request. Before returning, the daemon listens on
`<vsock>_5201` (apply) and `<vsock>_5200` (checkpoint), mode 0600. Each frame is a
four-byte big-endian length followed by its payload. JSON frames are at most
64 KiB. Data frames are at most 1 MiB; frame lengths above 1 MiB + 64 KiB are
rejected before allocating. These are host Unix endpoints for jobhost's vsock
forwarding, on guest ports 5201 and 5200 respectively.

Apply accepts one connection per mount. The host sends
`{v:1,kind:"apply",jobId,fromTree,toTree}`, index frames
`{index:[{path,mode,sha1,size}]}`, `{indexEnd:true,count}`, then file operations
and `{end:true,files,bytes}`. For a lineage's first mount, `fromTree` and checkpoint `baseTree` are empty strings:
empty means no tree. Guests must accept this initial state. These optional wire
fields may also be omitted; an omitted tree ID has the same meaning.
The index describes the complete target tree,
including on a warm mount with no operations. Operations are `put` (path, mode,
size, followed by exactly size bytes of data frames), `del` (path), `link`
(path, target) and `mode` (path, mode). The guest replies
`{applied:true,applyMs}` or `{applied:false,error}`. Status includes `applied`
and `applyMs`. A second connection is closed unread. Release closes listeners
and active connections.

Checkpoint POST accepts `{timeoutMs?,message?,trailers?}`. The default timeout
is 120000 ms; the maximum is 600000 ms. Only a pending POST arms a connection.
The host sends `{ready:true}` immediately to that connection. Unarmed or second
connections close unread. The guest retries every 50 ms, freezes only after
ready, then sends `{v:1,kind:"checkpoint",jobId,baseTree,walkMs}`, operations,
and `{end:true,files,bytes,freezeMs,skipped}`. The host prepares base-tree and quota metadata before ready, validates the complete
stream, and replies `{ack:true}` (or `{ack:false,error}`).
The guest thaws on ack, nack, EOF or its own deadline. Ack means received and
validated, without staging fsync. A crash before publication is retried from the guest index. Uploads, tree construction and image publication follow the ack;
jobhost must relay the successful POST's tree before the guest commits its index.
A publish failure leaves the ref and tree/root mappings untouched.

The response contains root, tree, commit, parentRoot, filesChanged, bytesReceived,
walkMs, streamMs, freezeMs, reflinkMs, fiemapMs, hashMs, uploadMs, publishMs and
imageMs, wallMs and checkpointMs. Mount locking is per job; waiting on one guest does not block
another mount's status, checkpoint or release. The manager lock protects only
the mount map. Blobs use Git SHA-1 object IDs and SHA-256 lineage records.
The tree builder reuses unchanged subtrees. One SQLite transaction publishes
the fenced commit/tree/root ref and its tree/root mapping.

Checkpoint hardening:

- Host arming, one checkpoint connection per POST and one apply per mount.
- Bounded frame reads, exact declared sizes, per-stream deadline, and caps:
  `--max-files 200000`, `--max-bytes 8589934592`,
  `--max-paths-bytes 67108864`. File bytes must also fit the image's virtual size.
- Paths must be relative UTF-8 without NUL, empty, dot or dot-dot components;
  at most 4096 bytes and 255 bytes per component. `.git` components are refused.
  Duplicate paths and file/directory conflicts are refused.
- Modes are 100644, 100755 or 120000. Link targets are at most 4 KiB and are
  stored as bytes, never followed by the daemon.
- The header must match the socket's job and the mount's current base tree.
- Invalid streams return 422 `bad-stream`; deadlines return 504 `stream-timeout`.
  Neither publishes a ref or tree/root mapping. Temporary files are removed.

Messages are UTF-8, at most 4 KiB, without NUL (default `checkpoint`). Trailers
accept `agent`, `run`, `turn`, `job`, `kind`, `exitCode`; kind is required when
trailers is supplied and is `auto`, `manual` or `job`. Identifier values match
`[A-Za-z0-9._:-]{1,128}`; exitCode is an integer. Invalid metadata returns 400
before arming. Each checkpoint stores a Git-exact commit in `objects`, with the
ref's previous commit as parent. Author is `agent:<agent>`, `job:<job>` or
`job:<jobId>`; committer is `camelfs`. The message is followed by the supplied
`Camel-Agent`, `Camel-Run`, `Camel-Turn`, `Camel-Job`, `Camel-Checkpoint` and
`Camel-Exit` trailers, in that order.

| Method and route | Meaning |
|---|---|
| `POST /v0/forks` | `{lineage,fromRef?,fromTree?,name,owner}` creates a new ref at the source tree/root. Exactly one source is required. Returns `{ref,tree,root}`. Held source refs return 409 `held`. No image or blob bytes move. |
| `GET /v0/commits/:id` | Returns `{commit,tree,parents,author,committer,message,trailers}`, parsed from stored Git commit bytes. |

`camelfsd testguest apply --vsock-dir D --job J --mount /mnt/x --index idx.json`
is a test-only guest. `checkpoint` with those flags refuses a non-mountpoint,
freezes, walks without following symlinks, streams changes, always thaws and
writes `idx.pending.json`. `checkpointed --tree T --index idx.json` promotes the
pending index only after publication. Apply opens parent components with
`openat` and `O_NOFOLLOW`, writes `.camelfs-tmp-*` files and renames them.
The walker skips `.git`, temporary files and special files; unreadable paths fail.
`testguest evil <case>` generates invalid streams for the hardening tests.
Loop tests skip without root or loop-mount support. The EC2 smoke adds a unit 3
stage and skips when `/nvme/host-free` is absent. It appends timings to
`scripts/ec2-smoke-results.txt`.

Prefetch now defaults to 64 chunks; all fetch/upload work shares the host's
64-operation store budget. Apply prefetches bounded windows at that depth.
`--hydration-pack-size` defaults to 4 MiB and must be a positive chunk multiple.

## Prefetch, hydrated snapshots and eviction (units 4–5)

One bounded worker pool per root serves all NBD connections. Demand joins the
cache single-flight for in-flight chunks. Sequential lookahead defaults to 64.
The first 65,536 first-touch offsets are recorded at release in
`patterns/<URL-escaped-lineage>.json`. The next cold mount in that lineage queues
that sequence before sequential lookahead. A mismatched pattern only fills cache.
Pools cancel when their last mount/connection releases them.

Every minute, and before a cold mount whose virtual size would cross 80% usage,
one LRU sweep removes cached chunks and complete images until filesystem usage
falls to 60%, or no eligible files remain. Cache hits and warm image use refresh
mtime at most once per minute per file. Live mounts pin their origin chunks and promoted images. Mount files,
blank images and live snapshots are never candidates. Each sweep logs bytes
removed and elapsed milliseconds. Reflink sharing can reduce the actual space
reclaimed; the sweep rechecks filesystem usage after each removal.

`ec2-smoke.sh` includes `ec2-unit45.sh`: a 4 GiB large-tree image, default
hydration, cold demand-only reads, two edited checkpoints, release, and an
isolated eviction timing. The 5k-file loop test prints `freeze_window_ms` through
ack and thaw. Both privileged tests and performance targets remain unverified
when `/nvme/host-free` or loop/reflink support is absent.

API errors use typed errors through wrapping, never message matching. Codes are
`invalid-request` (400), `ignored-path` (400), `hash-mismatch` (400),
`not-found` (404), `no-root-for-tree` (404), `fenced` (409),
`held` (409), `missing-blobs` (409), `bad-stream` (422),
`stream-timeout` (504), and `internal` (500).

`--lease-ttl` defaults to 5m. Renewal runs at ttl/5, and pauses after two
intervals without a status GET, checkpoint POST, or
`POST /v0/mounts/:jobId/heartbeat {}`. Keep sending heartbeats during long
operations. A taken-over lease fences the mount; status reports `fenced`
and checkpoint returns 409.

Both guest streams use `--stream-idle` (default 30s), reset at every received
or sent frame. Apply also uses `--apply-max` (default 30m); checkpoint uses
the POST's `timeoutMs` overall cap. A timeout sends a final nack/error trailer
with a fresh bounded write deadline before closing.

Device names are `camelfs-<8 hex SHA-256 of absolute data path>-<jobId>`.
Health reports `dmPrefix`; state records dm, loop and NBD devices and
`nbdListen`. After stopping guests and the daemon, run
`camelfsd cleanup --data DIR` to detach recorded devices and clear mount state.
Cleanup takes the same data-directory lock as the daemon.

Snapshots taken while ext4 is frozen can retain the journal's recovery-needed
flag. Read-only verification mounts must use `-o loop,ro,noload`; they must not
replay the journal. A VM's normal read-write mount replays it.


Checkpoint timing intervals nest: `wallMs ≈ arm+connect + streamMs + publishMs`;
`imageMs ⊂ publishMs`. `wallMs` runs from POST arrival to response.
`streamMs` runs from armed connection handover through ack, including the
guest walk. `walkMs` and `freezeMs` are guest-reported. `publishMs` runs
from ack to done. `imageMs` covers image fsync, reflink, FIEMAP, hashing,
chunk uploads, root and CAS. For one release `checkpointMs` aliases
`wallMs` for jobhost compatibility.

The lazy-origin cache verifies fetched chunks before atomic publication and
verifies existing disk chunks once per daemon lifetime. Trusted hits perform no
file read, hash or stat. Use timestamps update at most once per minute per hash.
A 256-entry open-file LRU serves NBD reads; eviction invalidates trusted entries
and retires descriptors after active readers finish.

## Cold network path (unit 7)

Hydrating cold mounts replay the lineage pattern, then prefetch every non-hole
chunk in offset order. The root pool is shared across connections and mounts;
`--fetch-depth` bounds network operations independently of lookahead. dm-clone
alone writes the destination and owns its hydration bitmap. Its batch size and
threshold are 256. NBD and the guest mapper device use 4 MiB readahead; logical
sectors remain 512 bytes, with four connections and 32 MiB maximum requests.

`--demand-slots` defaults to 16 of 64. Idle demand capacity can be borrowed;
borrowed background GETs are cancellable when demand arrives. Queued chunk
fetches can be displaced by demand. `GET /v0/stats` reports process totals:
`fetches`, payload `bytes`, `packsUsed`, uploaded `packBytes`, `rangeGets`,
`packGets` and trusted `cacheHits`. Take deltas between runs.

The reviewer runs `sudo scripts/ec2-unit7.sh` in a separately granted host slot.
It uses only `/nvme/camelfs-u7`, port 10811 and its own device prefix. Unit 1–5
host smokes already verified reflink, hydration and eviction; their recorded
results remain valid. All unit 7 host timings, the NIC ceiling and the ublk
comparison are **reviewer runs**, not measured by this coding session.

The bounded ublk experiment builds the upstream `libublk` loop example (source:
https://github.com/ublk-org/libublk-rs), with no daemon integration. If its QD1
mean latency is below 60% of NBD and QD16 IOPS exceed twice NBD, it warrants a
separate unit. Otherwise record `NBD stays; ublk is v1 (L19)`. L19's decision is
pending the reviewer table. L2's cold read/hydration numbers are likewise pending;
L61 was removed by unit 6.

## One storage format (unit 8)

Chunks remain 256 KiB, identified and deduplicated by SHA-256. Their bytes now
live only in `p/<packId>` objects. A pack concatenates one or more chunks with
no header, footer or padding between chunks. `--pack-max` defaults to 16 MiB;
it must be a chunk multiple between 256 KiB and 16 MiB. The pack ID is the
SHA-256 of the concatenated lowercase hexadecimal chunk hashes, in member order.
The final partial image chunk is zero-padded to 256 KiB before hashing.
Files remain separate Git blobs under `o/<sha1>`.

Roots retain `chunks: {"<image offset>": "<chunk sha256>"}` and add
`locations: {"<chunk sha256>": ["<packId>", <chunk index>]}` for every distinct
chunk. Roots carry their own lookup information. Different roots may name
different packs for the same hash. New roots have no `packs` field. No new
`c/<sha256>` objects are written by import or checkpoint.

Import streams non-zero chunks in offset order into bounded packs, with up to
64 pack PUTs in flight by default. Checkpoint batches just its FIEMAP delta into
new packs; unchanged chunks retain the parent's locations. Both paths reuse
locations already in the host's `refs.db` `chunk_locations` table
(`sha256 PRIMARY KEY, pack, idx, created_at`). Reading roots or whole packs also
records locations. The host checks the configured store before reusing an index
entry, so changing store namespaces cannot silently skip a needed upload.
An edit affecting seven new chunks writes one 1.75 MiB pack at the default limit.
Reverting to known bytes references their existing pack without an upload.

A demand cache miss makes one range GET for
`bytes=index*262144-(index+1)*262144-1`, then verifies the chunk's own hash.
Adjacent missing members within a demand request and the lookahead window
coalesce into a contiguous range. Hydration and root prefetch use whole packs
when at least half the pack is needed, otherwise contiguous ranges. If a root
references only part of a pack, a cached metadata lookup determines the pack
size for this decision. Whole reads verify every
member and the pack ID before publishing any cache bytes. Cache files remain
individual chunks. There is no window packer or background root rewrite.

### Existing roots and repack

Roots without locations still read `c/<sha256>`; unit-7 `packs` fields are ignored.
Before the review smoke reuses an existing chunk-format root, stop the daemon
and run this once (the data directory and store must match):

```sh
./camelfsd repack --data /nvme/camelfs --store s3://bucket/prefix --root OLD_ROOT
```

The command prints the new root ID. Mount that ID, or explicitly repoint the
caller's ref through its normal publication flow. Repack leaves refs and old
objects intact, takes the daemon's data-directory lock, and is idempotent.
A checkpoint of a legacy root also packs its remaining unchanged legacy chunks.

### GC (v1 design)

A pack is live while any live root references any member. Compaction rewrites
packs with a low live fraction and publishes roots naming the new locations.
Nothing is deleted in v0. The dedupe path still needs a reachability touch before
GC is enabled: `v0-limitation: L-dedupe-touch`. Pack bytes are durable and cannot be deleted
as a rebuildable tier.

### Host measurements: unit 8

Reviewer only: `sudo scripts/ec2-unit8.sh`. The script skips unless
`/nvme/host-free` exists. It uses a fresh S3 prefix, isolated data and devices,
and appends results under unit 8 in `scripts/ec2-smoke-results.txt`. It checks
import pack bytes against stored non-zero chunk bytes, zero `c/` objects, cold
first-file ranges, a cold full content read (`tar | cat`), hydration throughput
against the separately measured NIC ceiling, and a three-file checkpoint's
pack count and bytes. These measurements have not been run by the coding agent;
unit 1–7 host results do not validate the new format.
