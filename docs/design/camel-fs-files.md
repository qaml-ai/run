# camelRun's file model: repos, refs and trees, and nothing else

Status: design, 2026-11-13, for Miguel's review. Docs only. Miguel: "assume we're redesigning the system entirely
and remove concepts like the Volumes entirely. We'll figure out how to migrate." This document is that redesign:
camelRun's file model with camelFS ([camel-fs.md](camel-fs.md)) as the **only** concept. Volumes are gone. There is
no back-compat, and migration is out of scope except for one note at the end.

**The invariant.** Every file anywhere in camelRun lives in a camelFS lineage. A named, mutable **ref** points at
an immutable **tree**, and every change is a **commit**: a new tree, a commit object naming its parent and who made
it, and one fenced compare-and-swap of the ref. Nothing stores a file any other way: not an agent's workspace, not
a project, not a job's output, not an upload, not an attachment, not a workflow's logs.

What this buys, against today's Volumes: one lifetime rule (reachability from refs) instead of snapshots, pins,
forwarded pins, read-set claims, fork janitors and a GC with a candidate phase; O(1) forks and a real three-way
merge instead of a metadata copy and a commit that refuses any shared path; full history, diff, blame and
attribution for every file; a job that mounts a tree at kernel speed instead of a tar built from one R2 GET per
file; a search index over every version; and one implementation shared by the Workers backend, the Node backend,
the hosts and the SDKs. The cost is a checkpoint step for VM-held refs, and a commit per write for API-held ones.

## 1. The nouns, and the public API that replaces Volumes

Three nouns, one of them user-facing.

| noun | what it is | user-facing word |
|---|---|---|
| **repo** | a lineage: a versioned tree with refs, history and a search index; the unit of ownership, quota and chunk sharing. Today's "volume" and "project" are both repos | **repo** (recommended, see §8) |
| **ref** | a named, mutable pointer to a version; `main` by default; others for attempts, published versions, mirrors; every ref has an owner and dies with it | *branch* in the API where a user names one; `main` otherwise |
| **version** | an immutable commit: a tree id (git-compatible), parents, author, message and the attribution trailers; the id every cache, diff, mount and restore names | **version** |

Recommendation on the word: **repo**. Developers already know that a repo has branches, history, forks, diffs and
restores, which is exactly the surface; "workspace" collides with the agent's own mount, and "lineage" is a storage
term. A repo need not contain code: a shared docs folder is a repo with one branch.

**The API** (`/v1/repos`, replacing all twelve `/v1/volumes/*` paths):

| call | does |
|---|---|
| `POST /v1/repos { name?, key?, from?: { repo, ref? \| version? }, template? }` | creates a repo (idempotent by `key` or `Idempotency-Key`); `from` makes it a fork of another repo's version (O(1): the new repo's `main` points at that tree, nothing is copied); `template` seeds a first commit |
| `GET /v1/repos`, `GET /v1/repos/:id`, `DELETE /v1/repos/:id` | list, inspect (`{ id, name, key, refs, bytes, files, createdAt }`), delete (every ref goes; objects follow by reachability) |
| `GET /v1/repos/:id/refs`, `PUT /v1/repos/:id/refs/:name { version, expect? }`, `DELETE …/refs/:name?expect=` | the refs; `PUT` is the one mutation primitive underneath everything else, a CAS on `expect` |
| `POST /v1/repos/:id/branches { name, from?: ref \| version, owner?, ttl? }` | an O(1) branch inside the repo (shares chunks on hosts); `owner` ties its life to a workflow, job or agent |
| `GET /v1/repos/:id/history?ref=&limit=&path=` | first-parent history, with `merges: true` to descend into attempts |
| `GET /v1/repos/:id/diff?from=&to=&path=` | changed paths between any two versions, O(changed) |
| `GET /v1/repos/:id/blame?version=&path=` | per line: version, agent, run, call |
| `POST /v1/repos/:id/restore { ref, version, message? }` | a new commit on `ref` whose tree is `version`'s tree; history is never rewritten |
| `POST /v1/repos/:id/merge { into, from, mode?: "merge" \| "squash" \| "ff", renames? }` | three-way merge by tree, diff3 on co-edited text, conflicts answered with both sides and nothing written |
| files (§3) | `GET/PUT/DELETE …/files/:path`, `GET …/files`, `POST …/files:batch`, `POST …/commit`, `GET …/grep`, `GET …/blobs/:sha`, `POST …/links` |
| `GET /v1/repos/:id/export?version=`, `GET /v1/repos/:id.git/…` | a tar of a version; stock-git clone and fetch of the repo |

**Attribution trailers** on every commit, written by the runtime, never by the model: `Camel-Agent`, `Camel-Run`,
`Camel-Turn`, `Camel-Call`, `Camel-Job`, `Camel-Workflow`, `Camel-User` (an API key's subject or end user),
`Camel-Checkpoint: automatic | manual | api`. `history` and `blame` read them; the console shows them.

Gone with Volumes: `seq`, per-file `version` numbers (a write's precondition is the blob id the writer read),
`snapshots` and their pins and labels (a snapshot is a ref or a version id; labels are ref names), `changes(since)`
(use `diff`), `readSet`, `archive` (now `export`), `fork` as a metadata copy (now `from` on create, or a branch).

## 2. Agents

**Each agent's workspace is a ref:** the repo `agent:<id>` (made with the agent), ref `main`. Mounts are
`{ repo, ref?: "main", path, mode: "ro" | "rw", subpath?, notify?, instructions? }`; an agent sees its own
workspace at `/workspace` beside them, as today, with the same first-mount and `{workspace: …}` rules. A read-only
mount pins nothing: it names a ref, and reads of it resolve the ref's current version at each tool call (or a fixed
version, if the mount names one).

**How a turn's writes land**, by where the agent runs:

| agent | the ref is | writes | the turn checkpoint |
|---|---|---|---|
| on a computer (our hosts, [camel-fs.md](camel-fs.md) §1.5) | held: the VM mounts the ref's version as its disk, the host holds the lease | native ext4 writes in the VM | the automatic checkpoint at the end of every turn that wrote, after 30 s of dirtiness, before a fork, job, merge or sleep (§1.3 of the design): freeze → walk → stream → publish → fenced CAS |
| in a job | held, on a `job:<id>` branch | the same | at job end (`commit: true`), and periodically for long jobs |
| without a VM (Workers; most agents today) | unheld | **every file-tool write is a commit**: `write`/`edit` make a new tree and commit on the ref and CAS it; a tool that writes several files uses `commit` for one version | none needed: the ref is always durable |

The agent's tools keep their names (`read`, `write`, `edit`, `ls`, `glob`, `grep`, `present_file`) and the
"changed since you read it" check (the blob id). New on every workspace: `checkpoint(message)`, which on a held
ref is the manual checkpoint of the design (§1.3 of camel-fs.md) and on an unheld ref is a commit with the message
and no file changes (allowed; it names the current state); `restore(version | message-prefix)`, a new commit whose
tree is that version's; `history` and `diff`. One writer per ref, fenced (camel-fs.md §1.2): an API write to a held
ref is forwarded to the VM, and a VM-held ref is checkpointed before a fork or a job reads it.

**Attachments and tool outputs** are commits into the agent's workspace, as today's paths: `uploads/<request>/…`
for files sent with a message, `tool-outputs/<tool>/<call>/…` for files tools return, `tmp/` for scratch. A
file the agent was shown stays reachable for as long as its history refers to it: the agent's **history ref**
(`refs/history`, owned by the agent) points at a tree of the versions its transcript names, so a later `restore`
or `rm` on `main` never breaks a message that showed the file. Deleting the agent deletes the repo.

**Dream memory** is a repo an agent mounts read-write while dreaming and others mount read-only; today's
`agent_dreaming` check becomes a mount rule on the repo, not on a volume id.

## 3. The files API for Workers and clients

Served by the runtime (the Workers backend; the Node backend identically), reading objects from S3 and refs from
the repo's object (§6). Access is by token: a repo token names `{ repo, read: [ref globs], write: [ref globs],
exp, subject }` (camel-fs.md §1.10); an agent's token covers its mounts; an API key covers its tenant's repos; a
signed link covers one blob or one path for minutes. There is no other access path.

| call | semantics |
|---|---|
| `GET …/files/:path?ref=\|version=` | the file at a version (`version` wins; `ref` resolves at request time); headers carry `x-blob` (the content id), `x-version`, `x-mode`; `Range` honoured |
| `GET …/files?ref=\|version=&prefix=&glob=&after=&limit=&content=` | listing (`{ path, size, mode, blob }` per entry, paged); `content=true` returns the bytes too, up to the read-all cap, all from **one** version |
| `POST …/files:batch { ref \| version, paths?: [...], blobs?: [...] }` | many files in one response, fetched from S3 in parallel; an agent opening twenty files pays one round trip, not twenty (camel-fs.md §1.6) |
| `PUT …/files/:path?ref=&expect=<blob \| "none">`, `DELETE …/files/:path?ref=&expect=` | one file, one commit; `expect` is the blob the writer read (`none`: must not exist), refused with 412 and the current blob otherwise |
| `POST …/commit { ref, expect?: version, files: { path: { text \| data \| blob \| from: { repo, version, path } } \| null }, message? }` | several files as one commit; `blob` and `from` reference content the caller can already read, without re-sending bytes; `expect` is a whole-ref CAS |
| `GET …/grep?ref=\|version=&q=&regex=&path=&limit=` | the trigram index over the version's shards (camel-fs.md §1.7); literal and regex, path filters, 2,000-match cap; an unheld ref's answer is exact, a held ref's is as of its last checkpoint |
| `GET …/blobs/:sha` | the bytes of a content id, **immutable and cacheable forever**: this is the edge-cache path (Cloudflare Cache API keyed by `sha`), shared across repos, forks, agents and tenants that can name the blob; authorization happens when the tree is resolved, the blob fetch only needs a valid token for *some* repo (the id is the proof of knowledge) |
| `POST …/links { path \| blob, method, expiresIn?, maxBytes?, contentType? }` | a signed URL for one download or one upload (an upload lands as a commit on the ref named at signing); today's `file_link`/`file_import` builtins keep their shape |

Consistency: a version is immutable, so anything read by `version` is exact and cacheable; a read by `ref` is the
ref's version at request time; a held ref's reads are its last checkpoint unless `consistency=live` forwards to
the holder. Writes to a held ref are forwarded to the VM and are durable at its next checkpoint; the response says
so (`landed: "forwarded"`).

## 4. Jobs and workflows

`job({ at: ref | version, commit?: true | { onto: ref } })`. The host mounts the version's tree as the job's `/repo`
(a reflink of the image when warm, the lazy origin when cold; camel-fs.md §1.3) on a `job:<id>` branch of the
repo. Nothing is imported, synced or snapshotted: there is no per-job import (`/v0/trees`, `/v0/blobs`, the
`camelfs_trees` cache, the pinned volume snapshot) and no snapshot cache, because the tree the job wants is already
an object in S3 and the ref already names it.

A **commit job** checkpoints `/repo` at its end, **even when the command fails** (the exit status is in the
commit), and the branch `job:<id>` then points at the result. The workflow decides what happens to it:

- `merge(into: "main", from: job.branch)`: the three-way merge; clean → one commit on `main` with two parents (the
  attempt's history stays reachable and attributable), conflicts → `{ conflicts }` for a fix stage, which edits the
  same branch and merges again;
- `fast-forward` when `main` has not moved: the ref moves, zero bytes;
- or nothing: the branch is owned by the workflow and dies with it.

The result cache keys on the **tree** (`(tree, command, inputs)`), never a `seq`: equal content is a hit across
rollbacks, no-op merges and undiverged forks. A workflow's children get branches (`fork/<effect>`, owner the
workflow) instead of forked volumes; `commit()` in a script is `merge`. The `ForkJanitor`, `adopt`, fork pins,
`copyFork` and `forkChanges`-by-R2-key all go.

## 5. Everything Volumes did today

| today | with repos |
|---|---|
| **Projects / `publishTool`** (`clients/projects.ts`, `clients/python/.../projects.py`, `docs/guides/projects.md`): a volume per key; publish = snapshot, read every file at it, validate, store; `pin`/`labels` on the snapshot; `versions()`; `restore(version)`; `archive` | a repo per key (`POST /v1/repos { key, template }`); `publish` = read the tree at the current version of `main` (`files?version=&content=true` or `files:batch`), validate, store, then **`PUT refs/published/<n>`** at that version (and `refs/release/<label>` for a labelled one): a published version is a ref, kept for exactly as long as the ref exists; `keep: 20` deletes the oldest `published/*` refs; `pin` is a ref that `keep` does not touch; `versions()` lists `published/*`; `restore(version)` is `restore`; `archive` is `export`. `publishTool` is unchanged in shape: it finds the repo from the mount, publishes, answers the model |
| **Shares**: mounting one volume in several agents (ro or rw), fork pins (`seed`, `fork-base:<id>`, `forwarded_pins`, 7-day `FORK_SNAPSHOT_TTL_MS`), `history-pins.ts` | a mount names `{ repo, ref }`; many agents may mount one repo (one writer per ref at a time; a second rw holder gets its own branch and merges); nothing is pinned, ever: a fork is a ref and reachability keeps what refs reach; attachments are the history ref of §2 |
| **Workflow output, `keep()`** (`workflow-jobs.ts:246`): writes `/jobs/<id>/stdout.txt`, `stderr.txt`, `out/<name>` into the workflow's keyed volume `workflow:<wf>:files`, with a volume lookup and a quota check per write | **one commit** on the workflow's repo (`workflow:<id>`, owner the workflow) with every stream and output of the job as files under `/jobs/<id>/`, message "job <key> attempt <n>"; the script sees the tails inline as today; the 4.8 s result leg (ledger L70) becomes one object write and one CAS |
| **Uploads** (`PUT /uploads/:req/:name`, `file-upload.ts` R2 multipart with 5 MiB parts, signed `PUT` links) | an upload is a blob PUT (multipart past 64 MiB, straight to S3 through the runtime or a signed link) followed by a commit on the target ref at the path; the 15-minute upload window stays; the agent sees the file as a version |
| **Attachments and message files** (saved under `uploads/<request>/` in the workspace; tool outputs under `tool-outputs/`; `tool-files.ts` temp "directory snapshots" `[tool-call]<call>` with signed URLs for `{$file}` arguments) | commits into the workspace (§2); a `{$file}` argument is a signed link to a blob, no temporary snapshot; the history ref keeps what the transcript shows |
| **Account export** (`account-export.ts`: `volumes/<id>/volume.json` + `volumes/<id>/files/...` per volume) and **deletion** (`purgeAccountData` across agents and tenants) | export writes `repos/<id>/repo.json`, `repos/<id>/main/...` (the tree at `main`) and, when asked, `repos/<id>.bundle` (a git bundle with history, from the git edge); deletion deletes the tenant's repos' refs in one pass and lets reachability reclaim the objects; nothing to walk, nothing to tombstone |
| **Quotas** (`storage-quota.ts` 507 `STORAGE_LIMIT`, `tenant-storage.ts` daily reconcile, `VOLUME_LIMITS`: 256 MiB/file, 100k files, 16 mounts, 100 snapshots, 10k pinned, 1,000-file listings) | only real bounds (Miguel: no proactive caps): the account's storage limit (bytes of live objects reachable from the tenant's refs, counted at commit time in the repo object and reconciled from S3 Inventory), S3's 5 GiB single-PUT (multipart above), the read-all and listing page sizes as API paging, and the model-facing caps a tool needs (read 1 MiB, grep 2,000 matches). No file-size cap, no file-count cap, no snapshot caps, no mount cap beyond the environment text's size |
| **Signed links** (`/v1/agents/:id/links`, `/v1/volumes/:id/links`, `file_link`, `file_import`) | the same, on repos: a link names a blob (download) or a ref+path (upload → commit); `file_import` lands as a commit |
| **`notify`** on a mount (prompt the agent when others change files) | the repo object emits a change event when a ref it watches moves; the same coalescing |
| **Console** (`console/web/pages/volumes.tsx`, `files.tsx`, `workspaces.tsx`, `agent.tsx` file views) | a repos page: refs, history (first-parent, with attribution), a tree browser at any version, diff, restore, grep; the files component reads `files?version=` |
| **SDKs** (`VolumeHandle`: `info delete snapshot snapshots updateSnapshot deleteSnapshot archive restore commit fork changes list write read readText readAll`; Python `Volume`, `create_volume`, `read_all`) | `RepoHandle`: `info delete refs branch merge history diff blame restore commit write read readText list readAll export grep`; `agents.runtime.repos.create/get/list`; Python mirrors it; `projects.*` keeps its surface over repos |
| **OpenAPI** (`/v1/volumes/*` twelve paths; schemas `Volume`, `VolumeFile`, `VolumeInput`, `VolumeSummary`, `Snapshot`, `SnapshotInput`, `SnapshotMade`, `SnapshotUpdate`) | `/v1/repos/*`; schemas `Repo`, `RepoFile`, `RepoInput`, `Ref`, `Version`, `Commit`, `Diff`, `Blame`, `MergeResult` |

## 6. Where state lives

Two kinds of state, one write path.

**The repo object** (`RepoDO` on Workers, one per repo, SQLite; a `repos`/`refs` table pair with row locks on Node)
holds everything mutable and small: the **refs** (`name → version, tree, root?, owner, expiresAt?`), the **lease** of
each held ref (`holder`, `leaseEpoch`, `leaseDeadline`, the host's boot epoch; camel-fs.md §1.2's fence, every CAS
conditioned on it), the **quota counters** (bytes and files reachable at the current heads), the **watchers** for
`notify`, and a **cache of the head trees** (path → blob, mode, size, for each ref's current version) so `ls`,
`stat`, `glob` and the write-precondition check never leave the object. It is the authorization boundary and the
only place a ref changes.

**The storage plane** holds everything immutable and large, content-addressed, with no owner: **trees and commits**
(git's bytes, git's ids), **blobs** (file bytes), **chunks and roots** (the block images hosts mount), **packs**
(cold generations of trees and commits, clone packs) and **search shards**, all in S3 under one bucket per
environment (camel-fs.md §1.1); the hosts' `camelfsd` keeps the NVMe cache of chunks, images, trees and shards in
front of it, and the Workers read blobs and trees from S3 directly (SigV4) with the edge cache by hash in front.

**The single write path**, the same for a Worker's `PUT`, an agent's `edit`, a host's checkpoint and a merge:

1. write the new objects to S3 (blobs, trees, the commit): idempotent, content-addressed, unowned;
2. `RepoDO.cas(ref, expectVersion, newVersion, fence)`: one SQLite transaction that checks the expected version
   and the lease fence, moves the ref, updates the head-tree cache and the quota counters, and emits the change
   event. A host reaches it through the runtime (the host's existing WebSocket or the internal HTTP route), so the
   daemon never holds refs: `camelfsd`'s v0 SQLite ref store goes.

Objects written for a CAS that loses are garbage; the collector (reachability from refs, generational, from S3
Inventory; camel-fs.md §1.9) reclaims them, and a `touch` on every reference-by-id keeps a concurrent writer safe.

Why the refs are in the repo object and not in DynamoDB (where camel-fs.md put them): camelRun's control plane is
the runtime, every writer (Workers, hosts, the Node backend) already talks to it, the fence and the quota are
per-repo facts the object already owns, and the head-tree cache is what makes a Worker's file operation a local
read. DynamoDB stays the right answer for a camelFS deployed without camelRun; here the object is the simpler one.

## 7. What gets deleted, and the phases

**Deleted** (line counts from `main` on 2026-11-13):

| area | files | lines |
|---|---|---:|
| Workers volume model | `volume.ts` (the DO, its tables, the R2 `files/<tenant>/<volume>/<uuid>/<sha>` layout, snapshots, pins, forwarded pins, read-set claims, `gc_candidates`, the daily alarm), `volume-commit.ts`, `volume-policy.ts`, `file-upload.ts` (R2 multipart) | 1,061 + 125 + 58 + 84 |
| Workers routes and tools | `files.ts` (the twelve `/v1/volumes/*` routes; the Pi tools are rewritten over repos, ~400 lines stay), `file-mounts.ts` (keyed volume ids `vol_` + sha256; the `Mount` shape stays), `tool-files.ts` (temp snapshots and signed URLs; links stay), `history-pins.ts` | 1,160 + 214 + 147 + 21 |
| Workflows | `workflow-volumes.ts`, `workflow-forks.ts`, the `adopt`/fork paths of `workflow-results.ts`, the `keep()` volume writes in `workflow-jobs.ts` | 115 + 62 + ~50 + ~40 |
| Jobs | `jobs/camel-sync.ts`, `jobs/host-sync-store.ts`, `jobs/camelfs.ts` (the import bridge: `importTree`, `/v0/trees`, `/v0/blobs`), `camelfs_trees` in the Volume DO, `WireJob.files`/`sync`, `HostJob.files/fetch`, `pullFiles` and the guest `files` op past inline sizes | 150 + 37 + 82 + ~150 |
| Quotas | `storage-quota.ts` and `tenant-storage.ts` as separate reconcilers (the limit itself stays, counted in the repo object) | 29 + 116 |
| Node backend | `src/volumes.ts` (1 MiB chunks under `chunks/<tenant>/<aa>/<sha256>`, `chunk_pins`, `chunk_touches`, `gc_candidates`), `src/files.ts`, `src/storage-gc.ts`, `src/gc-verify.ts`, `src/pin-backfill.ts` | 1,192 + 278 + 115 + 94 + 86 |
| Daemon | `camelfsd`'s SQLite ref store and `/v0/trees` + `/v0/blobs` import endpoints (mount, fork, checkpoint, release, the cache and the lazy origin stay) | TBD with proto-block |
| Console, SDKs, OpenAPI, docs | `volumes.tsx` and the volume parts of `files.tsx`/`workspaces.tsx`/`agent.tsx`; `VolumeHandle` and Python `Volume`; the twelve paths and eight schemas; `docs/guides/files.md` "Volumes" and `projects.md` | rewritten over repos |

About **4,500 lines** of volume code go on Workers and **1,800** on Node; what replaces them is the repo object
(~800), the files API over it (~600), the tools rewrite (~400) and the SDK/console/OpenAPI rewrites, on top of
`camelfsd` and the design's storage plane, which already exist.

**Phases** (each a PR stack from `main`, each usable alone; v0's ledger continues throughout):

1. **The repo object and the API** (3 weeks): `RepoDO` with refs, fence, quota counters, head-tree cache; the
   object store writers for trees, commits and blobs from Workers; `/v1/repos/*` including files, `files:batch`,
   `commit`, `history`, `diff`, `restore`, `branches`, `merge`; tokens; the Pi file tools over repos for agents
   without a VM (every write a commit); `checkpoint(message)`, `restore`, `history`, `diff` as tools; the edge cache
   on `blobs/:sha`. New agents get repos; nothing else changes yet.
   Bar: a Worker file write ≤ 80 ms p50; `files:batch` of 20 files ≤ 150 ms; fork ≤ 50 ms; merge of 3 disjoint
   edits ≤ 200 ms; `history`/`diff` ≤ 100 ms at 50k files.
2. **Hosts, jobs and workflows on refs** (3 weeks): `camelfsd` takes its CAS from the runtime and drops its ref
   store; `job({ at: ref | version, commit })` mounts the tree with no import; the `job:<id>` branch, merge and
   fast-forward effects; result cache on the tree; `keep()` as one commit; computers mount the agent's ref with the
   lease (per camel-fs.md phase 2). The import bridge and `camel-sync` are deleted.
   Bar: job placement → first command ≤ 300 ms warm with no import leg (ledger L25, L43, L68 close); result leg
   (L70) ≤ 300 ms; a commit job's branch merges or fast-forwards in one effect.
3. **Everything Volumes did** (3 weeks): projects on repos with `published/*` refs; uploads and attachments as
   commits with the history ref; signed links on blobs; `notify` from the repo object; account export (tar + bundle)
   and deletion by refs; `grep` on the index for every agent; the console's repos page; SDKs and OpenAPI; the guides.
   Bar: `project.publish` round trip ≤ 1 s for a 5k-file project; export of a tenant with 100 repos streams without
   buffering; a deleted tenant's objects are unreachable within one GC cycle.
4. **Delete** (1 week): the Volume DO, the R2 layout, the Node volume files, the routes, the schemas, the console
   pages, the fakes; the ledger rows they carried flip to `fixed`.

**Later** (not in scope): migration of existing volumes into repos (one commit per volume from its file table,
a `published/<n>` ref per pinned snapshot, keyed ids preserved), done lazily on first touch or by a sweep when the
new model has run for a while.

## 8. Open questions for Miguel

1. **The word.** `repo` (recommended) or `workspace` for the user-facing noun; it names the API path, the SDK handle
   and every doc.
2. **Every API write is a commit.** It is the cleanest reading of the invariant and gives per-write history and
   blame, at ~10 small writes per file write (about $2k/month of object writes at the 1,000-agent baseline of
   camel-fs.md §1.13, falling ~3× with tree segments). The alternative is to coalesce a VM-less agent's writes within
   a turn into one commit at turn end, which halves the cost and loses per-write history. Recommendation: every
   write, with `commit` for multi-file tools.
3. **Refs in the repo object, not DynamoDB.** §6 moves them from camel-fs.md's DynamoDB into `RepoDO` (Workers) and
   Postgres rows (Node), because the runtime is where every writer already is. It couples camelFS's refs to the
   runtime; a camelFS without camelRun would need the DynamoDB variant. Accept the coupling?
4. **Published versions as refs.** `published/<n>` and `release/<label>` refs replace pinned snapshots and labels; a
   project with thousands of publishes has thousands of refs (cheap, but visible in `refs`). Alternatively a single
   `published` ref whose tree is a manifest of versions. Recommendation: refs, with `history` of `main` as the full
   record.
5. **What the history ref keeps.** §2 keeps every version an agent's transcript shows reachable for the agent's
   life, which is today's rule ("a file an agent was sent or shown stays until the agent is deleted"). Keep the
   rule, or let `rm` on `main` win and have the transcript's link fail after the fact?
