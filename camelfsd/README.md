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
Image import hashes only chunks intersecting SEEK_DATA/SEEK_HOLE extents.
Unsupported filesystems fall back to scanning the image.
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
--api-token-file accepts either a raw token (outer whitespace trimmed) or an
env-format file containing CAMELFS_API_TOKEN=<hex>, such as jobhost's
/etc/camel/camelfs-api.env (root-owned, mode 0600). Blank tokens are refused;
env values must be hex. Other env lines and comments are ignored when that key
is present.
The runtime listener serves /v1 plus exactly POST /v0/trees and
PUT /v0/blobs/:sha256?lineage=... using the Unix socket handlers. Both import
routes require the same bearer as /v1. Other /v0 paths return 404 on TCP;
host operations stay on the mode-0600 Unix socket. This replaces jobhost's
phase-1 import proxy on 127.0.0.1:8790: stop the proxy before enabling the
daemon listener, leaving the pilot VPC service address unchanged. Protect the loopback listener behind the runtime's private tunnel.
Never log the bearer. Every /v1 request, including a 401, logs one access line:
op=<METHOD>:/v1/<route> lineage=<l> status=<code> ms=<n>. Routes are templates;
object ids, file paths, query values and bodies are omitted. Lineages are
escaped to keep each request on one line. Health reports api: "127.0.0.1:8790".

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

Commit changes without moving a ref. parents is a required ordered array of
zero, one or two commit ids, each reachable in the lineage. An empty array
creates a root commit. Missing or null parents returns 400 invalid_request;
three or more parents returns 400 invalid_request; an unknown parent returns
400 unknown_commit. The singular parent field is rejected as an unknown field.
Each parent becomes a Git parent header in the supplied order. Omitted
baseTree uses the first parent's tree, or the empty tree for a root commit;
explicit null starts empty. changes may be an empty array to commit the base
tree without edits.
A mode-only change preserves the blob; deleting a missing path does nothing.
At most 10,000 changes are accepted. The author is supplied by the caller,
the committer is camelfs, and trailers are sorted Key: value lines.
The 201 response is {tree, commit, parents, time, changed, bytes}. parents is
always an array in the supplied order; time is the Unix seconds used in the
commit (the supplied time or the daemon's current time). tree and commit are
the Git object ids; changed counts changed paths and bytes counts supplied
blob bytes.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: commit-1' \
  -d "{\"parents\":[],\"baseTree\":null,\"changes\":[{\"path\":\"src/a\",\"blob\":\"$B\"}],\"author\":\"agent:a\",\"message\":\"first\",\"trailers\":{},\"time\":123}" "$A/commits"
```

List a tree in Git order. Nonrecursive listings include directories with
mode 040000 and tree. Recursive listings contain files. after is the last
returned path; next is provided when another page exists. Limit is 1–10000.
Size lookups are lineage-scoped and batched.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/trees/$T?path=src&recursive=1&limit=10000"
```

Single-entry stat descends one subtree per path component, without listing.
The tree must belong to the lineage (`404 not_found` otherwise); a missing path
returns `404 not_in_tree`. `path` is required: absent or empty is
`400 invalid_request` with `missing field path`. Absolute paths, empty or dot
components and trailing slashes return `400 invalid_request` with `invalid path …`.

| GET route (under `/v1/lineages/{lineage}`) | 200 response |
|---|---|
| `/trees/{tree}/entry?path=<path>` | `{ "path": "a/b", "mode": "100644" \| "100755" \| "120000", "blob": "<sha1>", "size": 1234 }` or `{ "path": "a", "mode": "040000", "tree": "<sha1>" }` |
| `/commits/{a}/is-ancestor?of=<b>` | `{ "ancestor": true \| false }` |
| `/merge-base?a=<commit>&b=<commit>` | `{ "base": "<commit>", "tree": "<tree>" }` or `{ "base": null, "tree": null }` |

Ancestry includes equality and follows every parent. Both commits must belong
to the lineage; `404 not_found` names the missing commit. Missing `of`, `a` or
`b` returns `400 invalid_request` with `missing field <field>`; malformed ids
return `400 invalid_request` with `invalid commit <id>`.
Is-ancestor walks only from `of`, stopping immediately when it reaches `a`;
it never loads `a`'s parent history. Merge-base uses a bidirectional
breadth-first walk marking generations. Both use the lineage-scoped commit
loader and visit at most 50,000 distinct commits (across both sides for
merge-base). Attempting to visit another returns `413 too_deep`, never false
or a null base.
Merge-base excludes common ancestors reachable from another common ancestor
(Git's best-common-ancestor rule). Multiple best candidates are resolved by
latest commit time, then lexicographically greatest commit id. Commit time
never lets a dominated ancestor win. Disjoint histories return a null base.

Read parsed commit metadata: tree, parents, author, message, trailers and time.

```sh
curl -H "Authorization: Bearer $TOKEN" "$A/commits/$K"
```

Diff returns added, modified, deleted and mode changes. Equal subtree ids
are pruned without reading their descendants; path filters to a prefix.
The response is `{ "changes": [ { "path": "a", "status": "added" | "modified" |
"deleted" | "mode", "oldBlob"?: "<sha1>", "newBlob"?: "<sha1>", "oldMode"?:
"<mode>", "newMode"?: "<mode>", "oldSize"?: 1234, "newSize"?: 5678 } ] }`.
Sizes come from loaded tree entries. Every side with a blob has a size,
including zero: added omits oldSize, deleted omits newSize, and mode has both.
Every tree writer (commits, imports, merges and checkpoints) publishes a
lineage-scoped `ts/<tree>` JSON sidecar with path, mode, blob/tree id and size
for each entry, in the same upload wave as `t/<tree>`. Its entries reconstruct
the Git tree id on write; on read they must match the verified Git tree's
entries in order, with nonnegative sizes. The daemon derives sizes from its
blob index or stored blob HEAD metadata when writing, never blob GETs.
Sidecars are the required size source for listings, entry stat and diff:
a missing sidecar is `500 internal` with `missing tree sizes <tree>`, with no
fallback to blob metadata or data.


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

Errors use {error:{code,message,details?}}. Every invalid_request message names
the invalid field or rule, including unknown JSON fields. Codes are invalid_request (400),
unknown_blob/unknown_tree/unknown_commit (400 on writes), blob_mismatch (400),
not_in_tree (404 on reads), too_large (413), conflict (409), no_fence (409),
unavailable (503). Conflict lists are in error.details.conflicts.

## Host API and guest streams

Examples use S=/run/camelfsd/api.sock.

```sh
curl --unix-socket "$S" http://localhost/v0/health
curl --unix-socket "$S" -d "{\"jobId\":\"j1\",\"lineage\":\"test\",\"tree\":\"$T\",\"parent\":\"$P\",\"fence\":{\"holder\":\"runtime\",\"epoch\":1},\"vsock\":\"/run/job.vsock\"}" http://localhost/v0/mounts
curl --unix-socket "$S" http://localhost/v0/mounts/j1
curl --unix-socket "$S" -d '{"timeoutMs":120000,"message":"checkpoint","trailers":{"kind":"manual"}}' http://localhost/v0/mounts/j1/checkpoint
curl --unix-socket "$S" -X DELETE http://localhost/v0/mounts/j1
curl --unix-socket "$S" -d "{\"lineage\":\"test\",\"path\":\"/nvme/base.img\",\"tree\":\"$T\"}" http://localhost/v0/images
```

Mount accepts exactly one of tree or root. An explicit fence requires parent, the 40-hex base commit ID. The CLI flag is `--parent`.
The fence is stored and echoed in status. Explicit null makes the image read-only and checkpoint returns
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
for one release. Today's order, for jobs: jobhost sends `checkpointed{tree}` to
the guest as soon as the daemon answers (`jobhost/agent.ts`), and the runtime
(`HostJob` → `RepoDO`) performs the CAS after the result arrives
(`backends/workers/src/jobs/hosts.ts`, `finishJobRepo`); that is safe only
because a job's VM is destroyed right after. Option C's order (camel-fs-files.md
§9.7), required for computers and `bash` VMs: the host calls the tier's `cas`
in-VPC first and sends `checkpointed{tree}` (or `{error}`) only after the ref
moved. Publication failure leaves tree_roots unchanged.

Stream defaults: --stream-idle 30s, --apply-max 30m, checkpoint timeoutMs
120000 (maximum 600000), --max-files 200000, --max-bytes 8589934592,
--max-paths-bytes 67108864. Guest paths and modes are validated before ack.
Bad streams return 422 bad-stream, timeouts 504 stream-timeout. Host errors
retain {error,detail}. Checkpoint messages/trailers retain their existing
validation and Camel-* mapping.

## Cold path

A warm mount is a writable reflink of `images/<root>.img`. A cold mount returns
`/dev/mapper/<prefix>-<jobId>` with `warm: false` and
`hydrating: true`. The accepted `hydrate` request field is ignored.
Before returning a cold mount, the daemon prefetches ext4 chunk 0, group
descriptors, group 0's inode table and bitmaps, and the root directory's first
block. Locations come from the superblock, descriptor and inode block mapping;
the journal superblock is included for the usual internal journal. The
verified cache serves these reads to NBD and later hydration without another
fetch. Unsupported layouts such as meta_bg keep lazy reads.
There is one cold path; `--hydration-pack-size` is removed.

The guest device is a persistent dm-snapshot with 512 KiB chunks. Its COW
store is a loop over sparse `mounts/<jobId>/cow.img`. `--cow-max` caps the
COW file's logical size, defaulting to the root's virtual size. Metadata
uses some capacity; filling the store invalidates the snapshot. Its origin
is a separate dm-linear device named `<prefix>-<jobId>-o`, initially over
the read-only NBD root export.

The daemon writes every non-hole 256 KiB root chunk into sparse `image.img`
with up to 64 workers. Fetched chunks are hash verified before one image write.
FICLONERANGE records the image range in the host cache without copying bytes.
Unsupported range cloning and partial final chunks use a second cache write.
Cached chunks are reused. Holes require no reads or writes. After fsync, the daemon suspends
the linear origin, reloads it over a loop of `image.img`, resumes it, and
detaches NBD. The snapshot and guest retain the same bytes. Subsequent reads
use only the kernel, loops and local disk. There is no post-hydration scan.
Status progresses from `cold` through `hydrating` to `hydrated` after the
swap, with `hydratedBytes`, `totalBytes`, `hydrationMBps`, and `swapMs`. Throughput is
non-hole bytes divided by elapsed hydration seconds in decimal MB/s, frozen
at completion. The caller measures `firstFileMs`. `GET /v0/stats` reports
process-lifetime `prehydrateBytes` (successful image writes during hydration)
and `reflinkedChunks` (successful chunk-cache range clones). Byte counts describe
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
at the default depth. The same host pool and demand reserve cover every mount; the cache has no
separate fetch pool. At depth one operations
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
Host /v0 tree, blob and commit GETs now require ?lineage=NAME. The development
CLI tree and cat commands take --lineage NAME before the tree id.

## Host and API roles

`camelfsd host` runs the block layer, cache, NBD and mounts. It serves
the Unix socket and can expose the runtime and import routes over TCP with
the existing shared bearer.

`camelfsd api` serves `/v1/lineages/{lineage}/*` over TCP for the ALB.
`GET /v0/health` needs no credentials and returns a JSON object containing
only `version`. `GET /v0/stats` reports local SQLite connection counts and
accepts a valid read or write token for any lineage.

```sh
camelfsd api --listen 0.0.0.0:8790 --data /var/lib/camelfsd \
  --store s3://bucket/prefix --region us-west-2 \
  --jwks-file /etc/camelfsd/jwks.json --token-issuer https://runtime.example
```

Each API node keeps its own SQLite caches, including its idempotency response
cache. Nodes can share the same object store, which is the durable source of
storage objects. `--fetch-depth` bounds concurrent store operations.

Send `Authorization: Bearer <jwt>` for storage requests. The runtime signs
the JWT using Ed25519 with `alg: "EdDSA"`, `typ: "camelfs+jwt"` and a `kid`
from its published JWKS. Claims include the configured `iss`,
`aud: "camelrun:camelfs"`, the actor `sub`, integer Unix seconds `iat` and
`exp`, the exact path lineage `lin`, and `acc` of `r` (read) or `w`
(read and write). Tokens may live up to `--token-max-ttl` (15 minutes by
default), with up to five seconds of future clock skew on `iat`. Include
`refs` as an array of up to 64 ref globs, which may be empty. The optional
`fence` contains a string `holder` and integer `epoch`. This release
validates the shape of `refs` and `fence`.

Provide exactly one JWKS source. Use `--jwks-file` for a local file or
`CAMELFS_JWKS` for the JSON itself. Each key specifies `kty: "OKP"`,
`crv: "Ed25519"`, `alg: "EdDSA"`, `use: "sig"`, `kid` and the base64url
public key `x`. To rotate file-backed keys, add the new key, send SIGHUP,
then remove the old key after its tokens expire and send SIGHUP again. A
failed reload keeps the previous keys. Restart env-backed nodes to rotate
their keys.
