# camelfsd

camelfsd is the storage plane behind the runtime's RepoDO. It stores immutable
Git blobs, trees and commits, sparse ext4 roots and 256 KiB chunks. RepoDO owns
refs, leases, fences and every CAS. The daemon never creates or advances a ref,
renews a lease, mounts an ext4 filesystem or walks guest files.

This branch contains units 1–6 and the unit 9 storage API. It does not include
the unit 7/8 cold-path or pack work.

Build on Linux with Go 1.24+, a C compiler (SQLite), and Linux headers:

```sh
cd camelfsd
go build -o /tmp/camelfsd ./cmd/camelfsd
go test ./...
go vet ./...
gofmt -l .
```

Host image operations require FICLONE under --data (normally XFS with reflink).
Clone mode also requires NBD/dm-clone modules, nbd-client, losetup, dmsetup and
root. prehydrate mode materializes the complete image before returning.
CAMELFSD_TEST_NO_REFLINK=1 is for unprivileged tests: it uses copies and hashes
whole images. Privileged loop/reflink tests skip when unsupported.

```sh
/tmp/camelfsd host --socket /run/camelfsd/api.sock --data /nvme/camelfs \
  --store s3://bucket/prefix --region us-west-2 --cold clone \
  --listen-api 127.0.0.1:8790 --api-token-file /run/camelfsd/token
```

An absolute directory in --store substitutes the local store. S3 uses the SDK
credential chain. No runtime TCP listener starts without --api-token-file.
The runtime listener serves /v1 plus exactly POST /v0/trees and
PUT /v0/blobs/:sha256?lineage=... using the Unix socket handlers. Both import
routes require the same bearer as /v1. Other /v0 paths return 404 on TCP;
host operations stay on the mode-0600 Unix socket. This replaces jobhost's
phase-1 import proxy on 127.0.0.1:8790: stop the proxy before enabling the
daemon listener, leaving the pilot VPC service address unchanged. Protect the loopback listener behind the runtime's private tunnel.
Never log the bearer. Health reports api: "127.0.0.1:8790".

## Durability and lineage scope

Objects are <lineage>/o/<git-sha1> (raw blobs), <lineage>/t/<git-sha1>
(Git trees), <lineage>/k/<git-sha1> (Git commits), <lineage>/r/<sha256>
(canonical roots) and <lineage>/c/<sha256> (chunks). Git hashes include the
object header; stored tree and commit payloads use Git's exact encoding. All
created trees and commits reach the store before a successful response. Trees
and commits are gathered into one publication with up to 64 uploads.
Blobs stream through a temporary file, hashing SHA-256 and Git SHA-1, and use
one file-backed PUT. Unknown-length requests replay the file to compute the
Git header after measuring its length. X-Camel-Sha256 mismatch is rejected
before any upload. Blob uploads are capped at 5 GiB.

refs.db is a host-local cache: mounts, tree_roots, tree_parents,
lineage_blobs, lineage_objects, uploaded, objects, and idempotency. There is
no refs table. Trees and commits are cached on write and on a cache miss;
reads verify their ids before caching. Small blob reads are also cached.

## Reachability

Existence under the lineage prefix is membership. The store is the source of
truth; lineage_objects and lineage_blobs are derived SQLite caches. Successful
writes fill them only after durable publication. A cache miss does one HEAD on
the lineage-prefixed object and refills the rows. Blobs carry x-camel-sha256
S3 metadata; HEAD also supplies size. The Local store keeps the same metadata
in a .meta sidecar beside each blob. There are no l/ membership markers.

Lineages are printable path segments of at most 128 bytes, without slash,
backslash or dot segments; colons are allowed. Cross-lineage store deduplication
is intentionally gone. Identical bytes are published separately in each lineage.
The host chunk cache remains keyed by verified content hash for local reuse.
NBD export names are <lineage>/<root>, so origin fetches use the correct prefix.
Old global objects require re-import; this change does not fall back to the
global namespace. On first startup with this layout, legacy lineage cache rows
and idempotency responses are cleared; subsequent restarts preserve them.

Every runtime route checks lineage membership. A blob GET additionally requires
a tree and path resolving to exactly that blob. A known hash alone grants no
read access. Large GETs above 8 MiB download through a bounded buffer into a
verified temporary file and use file-backed range serving; temporary files are
removed on success or failure. Only blobs at most InlineTree are cached inline.
Forks share a lineage.

Idempotency-Key caches successful mutation responses for 24 hours, scoped
by lineage and route. Replays return the original status and exact body
without recomputing or uploading. Only mutations with the same lineage and
idempotency key serialize through response publication; unrelated uploads
proceed independently. Errors are retryable and are not cached. Response replay is
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
status. Explicit null makes the image read-only and checkpoint returns
409 no_fence. A missing fence enables phase-1 compatibility, removed with
jobhost phase 2: the daemon synthesizes {holder: "<hostId>/<jobId>", epoch: 0},
logs op=mount legacy-fence jobId=... count=N, and permits checkpoints. The
process counter counts successful legacy mounts and is exposed as legacyMounts
in /v0/health; it resets when the daemon restarts. Every shim site is tagged
// TEMPORARY: removed with jobhost phase 2.
POST /v0/mounts/:id/heartbeat returns 200 {"ok":true,"deprecated":true} as
a no-op for one release: phase-1 compatibility, removed with jobhost phase 2.
No job ref is created. There is no forks route, lease TTL, or renewal goroutine.
The development CLI accepts --holder and --epoch for fenced mounts; an empty
holder sends explicit null for a read-only mount. Image import returns a root and records tree_roots
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

Checkpoint syncs the image, collects FIEMAP private extents before reflinking,
hashes changed ranges from the snapshot, and uploads chunks and roots.
Cold checkpoint waits for hydration and the early-write comparison.
dm-clone suspension covers FIEMAP and reflinking, not hashing or upload.
Release promotes a hydrated snapshot only after a completed clean comparison.
It never hashes the image. Read-only verification mounts of frozen snapshots
must use -o loop,ro,noload to avoid journal replay.

The shared store budget defaults to 64 operations (--fetch-depth); prefetch
lookahead is separately 64. Prehydrate uses 32 aligned windows, default 4 MiB.
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

Host /v0 tree, blob and commit GETs now require ?lineage=NAME. The development
CLI tree and cat commands take --lineage NAME before the tree id.
