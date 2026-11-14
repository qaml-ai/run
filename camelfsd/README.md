# camelfsd

camelfsd is the camelFS storage and compute plane. The API tier serves Git
objects, refs, leases and VM operations. Compute hosts run Firecracker
sessions with fenced ext4 mounts. The Go guest handles apply and checkpoint
streams.

Build on Linux with Go 1.24+, a C compiler (SQLite), and Linux headers:

```sh
cd camelfsd
go build -o /tmp/camelfsd ./cmd/camelfsd
go test ./...
go vet ./...
gofmt -l .
```

Compute hosts require FICLONE under `--data` (normally XFS with reflink).
`CAMELFSD_TEST_NO_REFLINK=1` uses copies and hashes whole images for unprivileged
tests. Privileged loop and reflink tests skip when unsupported.

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

## Session mounts and guest streams

Every session mount names a tree, its parent commit and the tier's lease fence.
The compute host selects the lineage's tree root, looks up to 64 tree ancestors,
or starts from a blank ext4 image (`--virtual-size`, default 1 GiB). A cached
image is reflinked. A cold image is fully hydrated before Firecracker starts.
The host retains session mount state for recovery after a daemon restart.

Apply uses the guest Unix endpoint `<vsock>_5201` and checkpoint uses
`<vsock>_5200`. Frames have a four-byte big-endian length and carry up to
64 KiB of JSON or 1 MiB of data. The apply header's tree fields can be empty
on the first mount.

A pending session checkpoint arms the guest connection. The host sends ready,
validates the stream and captures a disk snapshot before ack. The guest thaws
on ack, nack, EOF or deadline. The host publishes blobs, trees, the commit and
the image root, then performs the fenced CAS at the tier before sending
`checkpointed{tree}` to the guest.

## Host and API roles

`camelfsd host --compute` runs the session VM host and accepts tier pushes
on its mTLS compute listener. An absolute `--store` path selects a local
store. S3 uses the SDK credential chain.

`camelfsd api` serves `/v1/lineages/{lineage}/*` over TCP for the ALB.
`GET /v1/health` needs no credentials and returns a JSON object containing
only `version`.

```sh
camelfsd api --listen 0.0.0.0:8790 --data /var/lib/camelfsd \
  --store s3://bucket/prefix --region us-west-2 \
  --jwks-file /etc/camelfsd/jwks.json --token-issuer https://runtime.example
```

When compute is enabled, set `--listen-hosts 0.0.0.0:8794` for host
registration, heartbeats, and VM lifecycle callbacks. Route these calls
through an internal NLB with a TCP listener on 443 and a TCP target group
on 8794. Use a **TCP health check**. The host listener has no unauthenticated
HTTP route, and the NLB passes TLS through to camelfsd. The public storage
ALB continues to target port 8790. Tier pushes go directly to the host's
compute listener on port 8792.

The tier verifies host client certificates against `--hosts-ca-pem`.
The verified leaf must carry the clientAuth EKU and exactly one URI SAN
of the form `spiffe://camelfs/host/<id>` matching the request path.
The tier certificate and key (`--tier-cert` and `--tier-key`) serve both the
host listener and outbound pushes. The certificate requires serverAuth and
clientAuth EKUs, the `spiffe://camelfs/tier` URI for pushes, and a DNS SAN
matching the private host-channel endpoint for clients that verify its name.
After rotating the files, send SIGHUP to load the CA bundle and tier key
pair together for new connections. A failed reload keeps the previous
credentials.

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

### Lineages and refs

Configure both `--refs-table` (partition key `lineage`, sort key `name`) and
`--lineages-table` (partition key `lineage`) on `camelfsd api` to enable the
lineage and ref routes. Both use `--region`. For DynamoDB Local, also set
`--ddb-endpoint` to its URL. The host role has no ref routes.

A ref glob matches the whole name. `*` matches zero or more characters in a
single path segment. `**` also matches slashes. Listing and owner cleanup
include only refs covered by the token. Use `**` for lineage-wide owner cleanup.
URL-encode the ref name as one path parameter, especially when a ref name ends
in a route suffix such as `/lease`. A fence token must name one exact ref.

Lineage deletion freezes ref mutations across API instances while it checks for
held leases. A held lineage is reopened and returns `409 held`. A retry can
resume an interrupted sweep. The final conditional write records `deletedAt`.
Subsequent requests return `410 lineage_deleted`. An exact replay of a successful
keyed lineage deletion returns its original `204` while the idempotency entry
is available.
