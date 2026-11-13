# camelfsd

camelfsd is the storage plane behind the runtime's RepoDO. It stores immutable
Git blobs, trees and commits, sparse ext4 roots and 256 KiB chunks. RepoDO owns
refs, leases, fences and every CAS. The daemon never creates or advances a ref,
renews a lease, mounts an ext4 filesystem or walks guest files.

This branch contains units 1–6, the unit 7b cold path and the unit 9 storage API.
Packs and ublk remain v1 work (L19). Unit 7b fixes L76 and L2.

Build on Linux with Go 1.24+, a C compiler (SQLite), and Linux headers:

```sh
cd camelfsd
go build -o /tmp/camelfsd ./cmd/camelfsd
go test ./...
go vet ./...
gofmt -l .
```

Host image operations require FICLONE under --data (normally XFS with reflink).
Cold mounts require NBD and dm-snapshot modules, nbd-client, losetup, dmsetup
and root. Hydration always runs in the background.
CAMELFSD_TEST_NO_REFLINK=1 is for unprivileged tests: it uses copies and hashes
whole images. Privileged loop/reflink tests skip when unsupported.

```sh
/tmp/camelfsd host --socket /run/camelfsd/api.sock --data /nvme/camelfs \
  --store s3://bucket/prefix --region us-west-2 \
  --listen-api 127.0.0.1:8790 --api-token-file /run/camelfsd/token
```

An absolute directory in --store substitutes the local store. S3 uses the SDK
credential chain. No runtime TCP listener starts without --api-token-file.
The runtime listener serves only /v1; host operations stay on the mode-0600
Unix socket. Protect the loopback listener behind the runtime's private tunnel.
Never log the bearer. Health reports api: "127.0.0.1:8790".

## Durability and lineage scope

Objects are o/<git-sha1> (raw blob bytes), t/<git-sha1> (Git tree bytes),
k/<git-sha1> (Git commit bytes), r/<sha256> (canonical root JSON) and
c/<sha256> (chunks). Git hashes include the object header; stored tree and
commit payloads use Git's exact encoding. All created trees and commits reach
the store before a successful response. Object uploads use 16 workers.
Blobs stream through a temporary file, hashing SHA-256 and Git SHA-1, and use
one file-backed PUT. Unknown-length requests replay the file to compute the
Git header after measuring its length. X-Camel-Sha256 mismatch is rejected
before any upload. Blob uploads are capped at 5 GiB.

refs.db is a host-local cache: mounts, tree_roots, tree_parents,
lineage_blobs, lineage_objects, uploaded, objects, and idempotency. There is
no refs table. Trees and commits are cached on write and on a cache miss;
reads verify their ids before caching. Small blob reads are also cached.

Additional l/<sha256(lineage NUL kind NUL id)> membership records preserve
lineage authorization and blob size/SHA-256 metadata after a cache wipe.
The payload repeats the identity and is checked on recovery. This extra
namespace closes a gap in §9: durable bytes alone cannot restore the
lineage's reachability set. Existing data written before unit 9 must be
re-imported to establish membership.

Every runtime route checks lineage membership. A blob GET also requires a
tree and path resolving to that exact blob. A known hash alone grants no
read access. Trees, including subtrees, commits, blobs and roots written for
a lineage are recorded. Forks share a lineage.

Idempotency-Key caches successful mutation responses for 24 hours, scoped
by lineage and route. Replays return the original status and exact body
without recomputing or uploading. Keyed mutations serialize through response
publication. Errors are retryable and are not cached. Response replay is
host-local; wiping refs.db also wipes replay history. Deterministic commit
ids require an explicit time in Unix seconds. Otherwise Idempotency-Key
is the retry mechanism; the caller must preserve this cache across retries.

## Runtime API

All requests require Authorization: Bearer. Examples assume A is
http://127.0.0.1:8790/v1/lineages/test, TOKEN is the bearer, and B, T, K,
BASE, OURS and THEIRS are ids returned by earlier calls. Paths are relative
UTF-8, without empty, dot, dot-dot, NUL or .git components. File modes are
100644, 100755 and 120000.

Upload a blob. A first upload returns 201; repeated bytes return 200.
The optional X-Camel-Sha256 header checks the received bytes.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: blob-1' \
  -X PUT --data-binary @file "$A/blobs"
```

Read a blob through its tree and path. Range is supported; Content-Type is
sniffed from the first 512 bytes. X-Camel-Blob and X-Camel-Size describe it.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-99' "$A/blobs/$B?tree=$T&path=src/a"
```

Batch read returns multipart/mixed in request order, with X-Camel-Path,
Blob, Mode and Size headers. Missing paths have X-Camel-Error: not_in_tree.
The limits are 256 paths and 64 MiB (or a smaller maxBytes). Fetches use
64 workers. An oversized response names its first offending path.

```sh
curl -H "Authorization: Bearer $TOKEN" -d "{\"tree\":\"$T\",\"paths\":[\"src/a\",\"missing\"]}" "$A/read"
```

Commit changes without moving a ref. Omitted baseTree uses the parent's tree;
explicit null starts empty. Omitted/null parent creates a first commit.
A mode-only change preserves the blob; deleting a missing path does nothing.
At most 10,000 changes are accepted. The author is supplied by the caller,
the committer is camelfs, and trailers are sorted Key: value lines.
The response is {tree, commit, changed, bytes}.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: commit-1' \
  -d "{\"parent\":null,\"baseTree\":null,\"changes\":[{\"path\":\"src/a\",\"blob\":\"$B\"}],\"author\":\"agent:a\",\"message\":\"first\",\"trailers\":{},\"time\":123}" "$A/commits"
```

List a tree in Git order. Nonrecursive listings include directories with
mode 040000 and tree. Recursive listings contain files. after is the last
returned path; next is provided when another page exists. Limit is 1–10000.
Size lookups are lineage-scoped and batched.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/trees/$T?path=src&recursive=1&limit=10000"
```

Read parsed commit metadata: tree, parents, author, message, trailers and time.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/commits/$K"
```

Diff returns added, modified, deleted and mode changes. Equal subtree ids
are pruned without reading their descendants; path filters to a prefix.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/diff?from=$BASE&to=$T&path=src"
```

Merge takes unchanged subtrees by id. Co-edited text uses git merge-file -p;
NUL in the first 8 KiB marks binary content. All files must merge cleanly
before merged blobs or trees are uploaded. Conflicts return 409 with paths
and both_modified, delete_modify, binary or mode reasons. Squash computes
the same tree; RepoDO chooses the commit and performs CAS.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: merge-1' \
  -d "{\"base\":\"$BASE\",\"ours\":\"$OURS\",\"theirs\":\"$THEIRS\",\"mode\":\"merge\"}" "$A/merge"
```

Grep scans blobs with 64 workers, skips binaries, supports literal or Go RE2
queries, case folding, path globs, context lines and at most 2000 matches.
It returns matches, files, truncated and indexed: "scan". Trigram shards
are a later unit.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/grep?tree=$T&q=hello&regex=0&ignoreCase=1&path=src/*&limit=2000&context=1"
```

Errors use {error:{code,message,details?}}. Codes are invalid_request (400),
unknown_blob/unknown_tree/unknown_commit (400 on writes), blob_mismatch (400),
not_in_tree (404 on reads), too_large (413), conflict (409), no_fence (409),
unavailable (503). Conflict lists are in error.details.conflicts.

## Host API and guest streams

Examples use S=/run/camelfsd/api.sock.

```sh
curl --unix-socket "$S" http://localhost/v0/health
curl --unix-socket "$S" -d "{\"jobId\":\"j1\",\"lineage\":\"test\",\"tree\":\"$T\",\"fence\":{\"holder\":\"runtime\",\"epoch\":1},\"vsock\":\"/run/job.vsock\"}" http://localhost/v0/mounts
curl --unix-socket "$S" http://localhost/v0/mounts/j1
curl --unix-socket "$S" -d '{"timeoutMs":120000,"message":"checkpoint","trailers":{"kind":"manual"}}' http://localhost/v0/mounts/j1/checkpoint
curl --unix-socket "$S" -X DELETE http://localhost/v0/mounts/j1
curl --unix-socket "$S" -d "{\"lineage\":\"test\",\"path\":\"/nvme/base.img\",\"tree\":\"$T\"}" http://localhost/v0/images
```

Mount accepts exactly one of tree or root. fence is stored and echoed in
status. Null/omitted fence makes the image read-only and checkpoint returns
409 no_fence. No job ref is created. There is no forks or heartbeat route,
lease TTL, or renewal goroutine. The development CLI accepts --holder and
--epoch for fenced mounts. Image import returns a root and records tree_roots
without creating a ref. Import paths must resolve under --data, /nvme, or
a repeatable --import-allow directory.

Tree mounts still resolve the newest lineage/tree root, then up to 64
tree_parents ancestors, then the blank image (--virtual-size, default 1 GiB).
Apply uses the guest Unix endpoints <vsock>_5201 and checkpoint <vsock>_5200,
mode 0600. Frames have a four-byte big-endian length, at most 64 KiB of JSON
or 1 MiB of data. Header baseTree/fromTree/toTree are always present,
including empty strings for a lineage's first mount. Op fields stay optional.

Only a pending checkpoint POST arms a guest connection. The host prepares
metadata, sends ready, validates the stream, then sends ack before uploading.
The guest thaws on ack, nack, EOF or deadline. After ack the daemon writes
blobs, trees, the commit and the image root; records lineage_objects and
tree_roots; and returns {tree,root,commit,timings}. Flat timing fields remain
for one release. jobhost/RepoDO must perform CAS before telling the guest to
commit its pending index. Publication failure leaves tree_roots unchanged.

Stream defaults: --stream-idle 30s, --apply-max 30m, checkpoint timeoutMs
120000 (maximum 600000), --max-files 200000, --max-bytes 8589934592,
--max-paths-bytes 67108864. Guest paths and modes are validated before ack.
Bad streams return 422 bad-stream, timeouts 504 stream-timeout. Host errors
retain {error,detail}. Checkpoint messages/trailers retain their existing
validation and Camel-* mapping.

## Cold path

A warm mount is a writable reflink of `images/<root>.img`. A cold mount returns
`/dev/mapper/<prefix>-<jobId>` immediately, with `warm: false` and
`hydrating: true`. The accepted `hydrate` request field is ignored.
There is one cold path; `--cold` and `--hydration-pack-size` are removed.

The guest device is a persistent dm-snapshot with 512 KiB chunks. Its COW
store is a loop over sparse `mounts/<jobId>/cow.img`. `--cow-max` caps the
COW file's logical size, defaulting to the root's virtual size. Metadata
uses some capacity; filling the store invalidates the snapshot. Its origin
is a separate dm-linear device named `<prefix>-<jobId>-o`, initially over
the read-only NBD root export.

The daemon writes every non-hole 256 KiB root chunk into sparse `image.img`
with up to 64 workers. Cached chunks are reused; fetched chunks are hash
verified. Holes require no reads or writes. After fsync, the daemon suspends
the linear origin, reloads it over a loop of `image.img`, resumes it, and
detaches NBD. The snapshot and guest retain the same bytes. Subsequent reads
use only the kernel, loops and local disk. There is no post-hydration scan.
Status progresses from `cold` through `hydrating` to `hydrated` after the
swap, with `hydratedBytes`, `totalBytes`, and `swapMs`. Byte counts describe
non-hole data, independent of the virtual size. Hydration errors are exposed
as `hydrationError`; checkpoint fails rather than publishing partial data.

Cold checkpoint waits for hydration (normally seconds). The guest stream
waits before sending ready. While the guest is frozen, the daemon suspends
the snapshot and parses the persistent exception store: little-endian v1
header and old/new chunk pairs in metadata areas. It reflinks `image.img`
and applies COW exceptions to that copy before resuming and acknowledging
the guest. Reads submitted to a suspended snapshot queue, so capture reads
the COW offsets directly; this gives identical bytes without deadlock.
Hashing the candidate 256 KiB chunks and upload happen after resume. Equal
hashes are excluded from the delta, including on repeated checkpoints.
Promotion preserves holes by punching all-zero chunks in the reflink copy.
The format is documented in Linux `drivers/md/dm-snap-persistent.c`:
https://github.com/torvalds/linux/blob/master/drivers/md/dm-snap-persistent.c

Release removes the snapshot, then its linear origin, detaches loops and any
remaining NBD attachment, and deletes the mount directory. Completed hydration
promotes the immutable base `image.img` under its original root id without
hashing. Checkpoint images are promoted under their new root ids separately.
`camelfsd cleanup` removes both devices after a crash; stop guests first.

Discards do not pass from dm-snapshot to its origin. Guest `fstrim` on a
cold-started mount is a no-op. Space is reclaimed in promoted reflink plus
delta images, with holes preserved. Warm reflink mounts keep punch-hole
reclamation.

The shared store budget defaults to 64 operations (`--fetch-depth`). All
speculative fetches share a smaller budget, reserving eight slots for demand
at the default depth. The cache also reserves slots. At depth one operations
serialize. Prefetch lookahead is separately 64. A reserved slot cannot remove
NIC or disk contention; demand latency targets need measurement on the host.
A per-root bounded prefetch pool records first-touch patterns at release.
The cache verifies fetched chunks and keeps a 256-entry open-file LRU.
Eviction runs every minute and before cold mounts cross 80% disk usage,
aiming for 60%, protecting live mounts, blank images and snapshots.

State lives in images/, mounts/<jobId>/state.json, cache/ and refs.db.
A data-directory lock excludes concurrent daemons. Startup refuses leftover
mount state: after stopping guests, use camelfsd cleanup --data DIR.
Automatic mount recovery remains a later unit. Privileged smoke scripts
require the host availability gate and must only be run with human approval.
The unit-3 smoke uses explicit fences and tree mounts instead of forks.

Reviewer validation: `scripts/ec2-unit7.sh SOCKET DATA SOURCE_IMAGE [FIRST_FILE]`
runs against a disposable, already running daemon. It removes only imported
benchmark images to force cold mounts. Use a fresh daemon/data directory for
cold-cache trials. It reports the same 65 MiB of data at 1 and 16 GiB and the
large source root at 4, 16 and 64 GiB, swap time, hydration bytes, sampled
demand latency, and optional first-file time including filesystem mount.
Whole-device SHA-256 is compared after swap. Three raw chunk edits check the
checkpoint delta; a second checkpoint checks that unchanged exceptions do
not upload again. This harness does not measure a three-file guest stream
checkpoint. Use the loop guest-cycle tests for guest protocol coverage.
No real-host performance or COW integrity result is claimed until a reviewer
runs the root tests and harness. The demand samples include NBD misses and
cache hits; they are not an isolated cache-hit microbenchmark.
