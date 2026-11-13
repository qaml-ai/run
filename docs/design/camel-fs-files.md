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
| **ref** | a named, mutable pointer to a version; `main` by default; others for attempts, published versions, mirrors; every ref has an owner and dies with it. **Names** are `[A-Za-z0-9._-]` segments joined by `/` (`main`, `job/<id>`, `fork/<effect>`, `published/<n>`, `release/<label>`, `snap/<name>`, `dream/<key>`, `mirror/github/<branch>`), never a colon. Two names are derived rather than user-chosen: a cache ref is `cache/<sha256(key)[:32]>`, since cache keys carry arbitrary characters, and `mirror/github/<branch>` takes the GitHub branch name only when every character is in the set; a branch outside it is percent-encoded per segment, and a name that still does not fit (too long, empty segment) is refused at mirror setup, not mangled. **Owners** keep their colons and come from a fixed prefix set, `(agent|workflow|job|user|api|cache):<id>`, which `RepoDO` enforces on every branch create (confirmed with wf-repos, 2026-11-13) | *branch* in the API where a user names one; `main` otherwise |
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
| in a job | held, on a `job/<id>` branch | the same | at job end (`commit: true`), and periodically for long jobs |
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
| `POST …/files:batch { ref \| version, paths: [...] }` | many files in one response, fetched in parallel through the daemon's batch read (§9.2); an agent opening twenty files pays one round trip, not twenty (camel-fs.md §1.6). Paths only: every part is authorized by resolving in the version's tree, never by a bare hash |
| `PUT …/files/:path?ref=&expect=<blob \| "none">`, `DELETE …/files/:path?ref=&expect=` | one file, one commit; `expect` is the blob the writer read (`none`: must not exist), refused with 412 and the current blob otherwise |
| `POST …/commit { ref, expect?: version, files: { path: { text \| data \| blob \| from: { repo, version, path } } \| null }, message? }` | several files as one commit; `blob` and `from` reference content the caller can already read, without re-sending bytes; `expect` is a whole-ref CAS |
| `GET …/grep?ref=\|version=&q=&regex=&path=&limit=` | the trigram index over the version's shards (camel-fs.md §1.7); literal and regex, path filters, 2,000-match cap; an unheld ref's answer is exact, a held ref's is as of its last checkpoint |
| `GET …/blobs/:sha?version=&path=` | the bytes of a content id, **immutable and cacheable forever**, and the edge-cache path: the Worker first checks that the caller's repo reaches the blob (`path` resolves in `version`'s tree to exactly `sha`, confirmed by the repo object's head-tree cache or by the daemon, §9.1), **then** looks the bytes up in the Cloudflare Cache API by `sha` and fetches from the daemon on a miss. The cache stays shared across repos, forks, agents and tenants because it is keyed by content, but no request is served on the strength of knowing a hash: hashes leak through listings, git edges, logs, URLs and errors, and a known-content hash must never confirm a file's existence in another tenant. A request without a resolving `(version, path)` is `404` whether or not the bytes exist |
| `POST …/links { path \| blob, method, expiresIn?, maxBytes?, contentType? }` | a signed URL for one download or one upload (an upload lands as a commit on the ref named at signing); today's `file_link`/`file_import` builtins keep their shape |

Consistency: a version is immutable, so anything read by `version` is exact and cacheable; a read by `ref` is the
ref's version at request time; a held ref's reads are its last checkpoint unless `consistency=live` forwards to
the holder. Writes to a held ref are forwarded to the VM and are durable at its next checkpoint; the response says
so (`landed: "forwarded"`).

## 4. Jobs and workflows

`job({ at: ref | version, commit?: true | { onto: ref } })`. The host mounts the version's tree as the job's `/repo`
(a reflink of the image when warm, the lazy origin when cold; camel-fs.md §1.3) on a `job/<id>` branch of the
repo. Nothing is imported, synced or snapshotted: there is no per-job import (`/v0/trees`, `/v0/blobs`, the
`camelfs_trees` cache, the pinned volume snapshot) and no snapshot cache, because the tree the job wants is already
an object in S3 and the ref already names it.

A **commit job** checkpoints `/repo` at its end, **even when the command fails** (the exit status is in the
commit), and the branch `job/<id>` then points at the result. The workflow decides what happens to it:

- `merge(into: "main", from: job.branch)`: the three-way merge; clean → one commit on `main` with two parents (the
  attempt's history stays reachable and attributable), conflicts → `{ conflicts }` for a fix stage, which edits the
  same branch and merges again;
- `fast-forward` when `main` has not moved: the ref moves, zero bytes;
- or nothing: the branch is owned by the workflow and dies with it.

The host's result (`WireResult.camelfs`: `tree`, `root`, `commit`, `checkpointError`, the timings) stays as the
transport and becomes the `job/<id>` branch's version plus its timings in the job result; `WireResult.camelfs` is
not a public shape.

**Inline files.** `job({ files })` and the agent's `job_run({ files })` (a job with a few inline files and no repo)
become **one path**: the runtime commits the inline files onto a scratch `job/<id>` branch of the caller's repo (the
workflow's repo, or the agent's workspace) and the job mounts it like any other; the guest `files` op and
`WireJob.files` go. Default (wf-delegation's recommendation), Miguel may override.

**The agent's `job_run` tool** gains the same `at: ref | version` and `commit` as `job()`, and its model-facing text
changes from "`at` (a volume id) starts it with that volume's files … (changes are not saved back)" to "`at` names a
repo ref or version to start from; with `commit: true` the job's `/repo` is saved as a version you can `restore` or
merge". That text is model-facing and is reviewed line by line, like `checkpoint`'s.

**`push()`** keeps its script API (`push({ ref, to })`) and runs on the git edge's mirror (camel-fs.md §1.8) from the
ref, with the App token the runtime mints; it is no longer a job running `PUSH_SCRIPT` with the token in a process.

The result cache keys on the **tree** (`(tree, command, inputs)`), never a `seq`: equal content is a hit across
rollbacks, no-op merges and undiverged forks. A workflow's children get branches (`fork/<effect>`, owner the
workflow) instead of forked volumes; `commit()` in a script is `merge`. The `ForkJanitor`, `adopt`, fork pins,
`copyFork` and `forkChanges`-by-R2-key all go.

## 5. Everything Volumes did today

| today | with repos |
|---|---|
| **Projects / `publishTool`** (`clients/projects.ts` 203, `clients/python/camelai_run/projects.py` 176, `docs/guides/projects.md`, their tests; client-side only, over keyed volumes and `published:<v>` pinned snapshots, `keep` ≤ 90 because a volume holds 100 snapshots) | **Dropped (Miguel, 2026-11-13).** The pattern replaces the feature, with no runtime or SDK surface of its own: (1) a keyed ref: `POST /v1/repos { key }` makes the repo once; (2) an agent mounts it (`{ repo, path: "/bot", mode: "rw" }`); (3) the app reads the tree at a version (`files?version=&content=true`), checks it, and **moves a `published` ref (or a `release/<label>` tag) to that version** with `PUT refs/published { version, expect }`; (4) the app **serves from the tree at `published`** (`files/:path?ref=published`, or `blobs/:sha` through the edge cache), so there is no copy into the app's own storage; (5) versions are just `history` of `published` and `main`; `restore` is `restore`. The model-facing publish tool becomes a **short SDK example**: a served tool whose handler does (3) and answers the model with the problems or the version. camel-bots is the one consumer (bot source lives in project snapshots today); its move onto this pattern is migration, later |
| **Shares**: mounting one volume in several agents (ro or rw), fork pins (`seed`, `fork-base:<id>`, `forwarded_pins`, 7-day `FORK_SNAPSHOT_TTL_MS`), `history-pins.ts` | a mount names `{ repo, ref }`; many agents may mount one repo (one writer per ref at a time; a second rw holder gets its own branch and merges); nothing is pinned, ever: a fork is a ref and reachability keeps what refs reach; attachments are the history ref of §2 |
| **Workflow output, `keep()`** (`workflow-jobs.ts:246`): writes `/jobs/<id>/stdout.txt`, `stderr.txt`, `out/<name>` into the workflow's keyed volume `workflow:<wf>:files`, with a volume lookup and a quota check per write | **one commit** on the workflow's repo (`workflow:<id>`, owner the workflow) with every stream and output of the job as files under `/jobs/<id>/`, message "job <key> attempt <n>"; the script sees the tails inline as today; the 4.8 s result leg (ledger L70) becomes one object write and one CAS |
| **Uploads** (`PUT /uploads/:req/:name`, `file-upload.ts` R2 multipart with 5 MiB parts, signed `PUT` links) | an upload is a blob PUT (multipart past 64 MiB, straight to S3 through the runtime or a signed link) followed by a commit on the target ref at the path; the 15-minute upload window stays; the agent sees the file as a version |
| **Prompt attachments and message files** (`prompt-attachments.ts`: saved under `uploads/<request>/` in the writable mount, then pinned `agent:<id>`; history holds `FileRef { key, volume, path, version, sha256 }`; `history-pins.ts` copies the pins to a forked agent; `file-output.ts` pins presented files under `file-pin-volumes`; Node `chunk_pins`, `pin-backfill.ts`) | commits into the workspace (§2); history holds `{ repo, version, path, blob }`; the agent's **history ref** keeps every version the transcript names reachable, so there are no pins, no pin inheritance (a forked agent's history ref starts as its parent's) and no backfill |
| **Tool-output files and signed file links** (`tool-output-files.ts`: `<mount>/tool-outputs/<tool>/<hash8>/`; `tool-files.ts`: a per-call temporary snapshot `[tool-call]<call>` for directory `{$file}` arguments and `/v1/files/<token>/<name>` URLs streaming a file, a manifest or a tar.gz from R2; `file-links.ts`; `/v1/links/<token>/<name>`; Node `tool-files.ts`, `file-arguments.ts`, `FileUrls`) | tool outputs are commits into the workspace at the same paths; a `{$file}` argument is a signed link to a blob (a file) or to a version and path prefix (a directory, served as a tar of that subtree), with no temporary snapshot because the version is already immutable; `/v1/files/<token>/…` and `/v1/links/<token>/…` keep their shapes over blobs and versions |
| **Dreaming memory** (`agent_dreaming.volume`, `shared/dreaming.ts`, `dreaming.ts`: reads the volume with `content=true`, publishes a pinned snapshot labelled `dream:<key>`, then `restore`s; `file-mounts.ts:174` forces other agents' mounts of it read-only) | a repo the dreaming agent holds `main` on and others mount read-only; a published dream is `PUT refs/dream/<key>` at the version; the read-only rule is the one-writer rule on the ref, not a volume check |
| **Account export** (`account-export.ts`: `volumes/<id>/volume.json` + `volumes/<id>/files/...` per volume) and **deletion** (`purgeAccountData` across agents and tenants) | export writes `repos/<id>/repo.json`, `repos/<id>/main/...` (the tree at `main`) and, when asked, `repos/<id>.bundle` (a git bundle with history, from the git edge); deletion deletes the tenant's repos' refs in one pass and lets reachability reclaim the objects; nothing to walk, nothing to tombstone |
| **Quotas and billing** (`storage-quota.ts` 507 `STORAGE_LIMIT`; `tenant-storage.ts` DO with `storage_objects`/`storage_total` and a daily R2 reconcile; Postgres `storage_usage(kind agent\|volume\|tenant, owner, bytes)`; `billing.ts` `storageLimit` from the plan, 1 GB free / 100 GB paid, 402 when the prepaid balance is gone; Node `chargeStorage` daily at $0.10/GB-month; `VOLUME_LIMITS`: 256 MiB/file, 100k files, 16 mounts, 100 snapshots, 10k pinned, 1,000-file listings) | only real bounds (Miguel: no proactive caps): the account's storage limit, now **bytes of live objects reachable from the tenant's refs**, counted by the repo object at each CAS (the tree's byte total is known) and reconciled from S3 Inventory, billed daily at the same $0.10/GB-month as one `storage` ledger line per tenant; S3's 5 GiB single PUT (multipart above); the read-all and listing page sizes as API paging; the model-facing caps a tool needs (read 1 MiB, grep 2,000 matches). No file-size cap, no file-count cap, no snapshot caps, no mount cap beyond the environment text's size. `storage_usage`, `TenantStorage` and the reconcile go |
| **The Node backend's `VolumeService`** (`src/volumes.ts` 1,192: `volumes/<id>/tree` append log folded every 1,024 records, snapshots as blobs, 1 MiB chunks under `chunks/<tenant>/<aa>/<sha256>`, one node owning each volume with peer forwarding and idle release, `volume_watchers`; `volume-tools.ts`, `volume-env.ts`, `storage-gc.ts`, `storage-integrity.ts`, `gc-verify.ts`, `pin-backfill.ts`) | the same repo API over the same objects: refs in Postgres rows locked per repo (§6), objects in DynamoDB and S3, the daemon on the Node hosts; `VolumeEnv` becomes a repo-backed `ExecutionEnv`; the per-node ownership, forwarding, chunk pins and GC go, because nothing on a node is truth |
| **Signed links** (`/v1/agents/:id/links`, `/v1/volumes/:id/links`, `file_link`, `file_import`) | the same, on repos: a link names a blob (download) or a ref+path (upload → commit); `file_import` lands as a commit |
| **`notify`** on a mount (prompt the agent when others change files) | the repo object emits a change event when a ref it watches moves; the same coalescing |
| **Console** (`pages/volumes.tsx` 145: list, create, delete volumes and snapshots; `components/files.tsx` 233: the file browser with list, upload, delete and signed-URL preview over `/v1/volumes/:id/files`; per-mount browsers in `agent.tsx`; counts in `account.tsx`) | a repos page: refs, history (first-parent, with attribution), a tree browser at any version (the file browser reads `files?version=` and previews through `blobs/:sha`), diff, restore, grep; the per-mount browser on the agent page points at the mount's repo and ref |
| **`push()`** (`workflow-jobs.ts` `pushSpec`: a job whose `at` is the volume to push, with the GitHub token in the job's process) | the git edge's mirror (camel-fs.md §1.8) from a ref, with the App token the runtime mints; no job (§4) |
| **`apply`** (declarative provisioning: `shared/apply.ts`, `apply.ts`, `apply-api.ts` create keyed volumes, cached per apply run) | an `apply` manifest names repos by key (`repos: [{ key, template? }]`); the same create-by-key, idempotent; mounts in manifests name `{ repo, ref? }` |
| **Computers** (`computers/objects.ts:334` seeds a container from `inlineFiles` or `volumeFiles()` through `camel-sync`; `computers/policy.ts:30` and the `agent-tools.ts` computer text tell the model to `cp` results to a volume; Node `computers/transfers.ts` moves files volume ⇄ computer, 256 MiB) | a computer **mounts the agent's repo ref** as its disk (camel-fs.md §1.5), so there is nothing to seed or transfer: files written in the machine are commits at the turn checkpoint, and files written through the API appear in the machine; the model-facing computer text drops "cp to a volume" (reviewed line by line); `transfers.ts` goes |
| **Agent fork of a workspace** (`agent-workspace.ts`: an R2 fork-claim object, `claimReadSet`/`copyReadSet` on the source workspace, `releaseReadSet("fork:<id>")`) | `POST /v1/repos { from: { repo: parent workspace, version } }` at the parent's current version: O(1), no claim, no copy; the child's history ref starts as the parent's (§2) |
| **Images and media** (`media/images.ts:285–344` saves generated images to a volume when `volumeId` is given; `media-api.ts` takes and returns `volumeId` + `path` for images and transcriptions; `model.ts` ~81 reads image inputs for the model by decoding R2 `files/<tenant>/<volume>/…` keys) | the media API takes and returns `{ repo, ref?, path }` and `{ repo, version, path, blob }`; a generated image is a commit; the model layer reads an image input as a blob by `(repo, version, path)` through the files API, never by storage key |
| **Channels** (`channels.ts` mounts, reads and signs links to volume files for channel messages, through `handleAgentFilesRoute` and `signVolumeLink`) | a channel attachment lands like an upload (a commit under `uploads/<request>/`); outgoing files are signed links to `(version, path)` |
| **MCP `add_schedule` mounts** (`packages/cli/src/tools.ts:196`, `hosted-mcp-tools.ts:197`: the mounts schema names `volumeId`) | the schema names `{ repo, ref?, path, mode }`; nothing else changes |
| **Evals** (`evals/workflows/lib/runtime.ts`, `choice.ts`, `run.ts` create volumes, write files, mount them, snapshot through the SDK) | the same through `RepoHandle`; the eval corpus is a repo per case made by key, forked per run |
| **Admin usage** (`admin-usage.ts` on both backends counts volumes and storage per tenant) | counts repos, refs and reachable bytes from the repo objects' counters |
| **Tool-result file shapes** (`file-output.ts`: `PresentedVolumeFile` / `WrittenVolumeFile` with signed links, the shape tool results use to hand files back) | `PresentedFile { repo, version, path, blob, size, link }`; the pinning half (`file-pin-volumes`, `releasePresentedFiles`) is the history ref |
| **SDKs** (`VolumeHandle`: `info delete snapshot snapshots updateSnapshot deleteSnapshot archive restore commit fork changes list write read readText readAll`; Python `Volume`, `create_volume`, `read_all`) | `RepoHandle`: `info delete refs branch merge history diff blame restore commit write read readText list readAll export grep`; `agents.runtime.repos.create/get/list`; Python mirrors it; `projects.*` keeps its surface over repos |
| **OpenAPI** (`/v1/volumes/*` twelve paths; schemas `Volume`, `VolumeFile`, `VolumeInput`, `VolumeSummary`, `Snapshot`, `SnapshotInput`, `SnapshotMade`, `SnapshotUpdate`) | `/v1/repos/*`; schemas `Repo`, `RepoFile`, `RepoInput`, `Ref`, `Version`, `Commit`, `Diff`, `Blame`, `MergeResult` |

## 6. Where state lives

**Decided (Miguel, 2026-11-13): the state split.** Refs, history, leases and fencing epochs live in the
**per-lineage Durable Object's SQLite**; trees and commits live in **DynamoDB**, with cold generations packed to
S3; blobs and chunks live in **S3**. camel-fs.md §1.2 is updated to match (it had refs in DynamoDB). The reasons:

- every ref change already passes through a Durable Object: the agent's turn, a `HostJob`'s result, the API's
  request; a second store for refs would be a second hop on every one of them;
- Workers resolve ref → tree locally on every file-API call, and refs cannot be edge-cached because they are
  mutable; trees and commits can, by hash;
- one serial owner per lineage gives a transactional CAS, the lease fence, the quota counter and SQL history (the
  ref's log is a table the console reads) without a cross-store protocol;
- the immutable objects stay next to the hosts, in the region they are read from, in stores that scale without an
  owner.

**The repo object** (`RepoDO` on Workers, one per repo; a `repos`/`refs`/`ref_log` table set with row locks per
repo on Node) holds everything mutable and small: the **refs** (`name → version, tree, root?, owner, expiresAt?`),
the **ref log** (every move: from, to, who, when, why; what `history` reads before descending into commits), the
**lease** of each held ref (`holder`, `leaseEpoch`, `leaseDeadline`, the host's boot epoch; every CAS is conditioned
on it), the **quota counters** (bytes and files reachable at the current heads), the **watchers** for `notify`, and a
**cache of the head trees** (path → blob, mode, size, for each ref's current version) so `ls`, `stat`, `glob` and
the write-precondition check never leave the object. It is the authorization boundary and the only place a ref
changes.

**The object stores** hold everything immutable and large, content-addressed, with no owner: **trees and
commits** in DynamoDB (git's bytes, git's ids; ≤ 400 KB items, an S3 stub past that; cold generations packed to
S3 `g/`), **blobs** (file bytes), **chunks and roots** (the block images hosts mount), **packs** (the read tier for
hydration; clone packs) and **search shards** in S3 under one bucket per environment (camel-fs.md §1.1). The hosts'
`camelfsd` keeps the NVMe cache of chunks, images, trees and shards in front of them. The Workers reach the objects
through the daemon's contract (§9) over the `CAMELFS` binding tonight and the API tier later; trees and commits can
also be read from DynamoDB over HTTPS and edge-cached by id, since they are immutable; blobs are edge-cached by id
after the (version, path) check of §3.

**Tonight's interim (ledger L74).** Until Miguel creates the DynamoDB table, `camelfsd` writes trees and commits
durably to S3 (`t/<sha1>`, `k/<sha1>`) and serves them from there and its cache; the swap to DynamoDB is internal to
the daemon and changes nothing in §9. v0's daemon-local SQLite ref store on the m8id's instance-store NVMe (wiped by a
stop; ledger L73) is replaced by the repo object as this design lands.

**The single write path**, the same for a Worker's `PUT`, an agent's `edit`, a host's checkpoint and a merge:

1. write the new objects (blobs to S3; trees and the commit to DynamoDB): idempotent, content-addressed, unowned;
2. `RepoDO.cas(ref, expectVersion, newVersion, fence)`: one SQLite transaction that checks the expected version
   and the lease fence, moves the ref, appends the ref log, updates the head-tree cache and the quota counters, and
   emits the change event. A host reaches it through the runtime (its WebSocket, or the internal HTTP route), so the
   daemon never holds refs. From the daemon's side (proto-block): it is handed a fence `(holder, epoch)` at mount,
   calls `check(fence)` before arming the checkpoint stream and `cas(fence, { tree, root, commit }, expect)` after
   publishing, one round trip each inside the checkpoint wall; lease renewal, heartbeat and takeover move to the
   runtime whole; the hydrated-image promotion and the host's `tree_roots` stay host-local; a mount without a fence
   (a read-only `root`-form mount) refuses checkpoints, as today's "no ref" does.

Objects written for a CAS that loses are garbage; the collector (reachability from refs, generational, from S3
Inventory; camel-fs.md §1.9) reclaims them, and a `touch` on every reference-by-id keeps a concurrent writer safe.

**Cross-lineage operations without a global transaction.** Two operations touch more than one repo, and neither
needs atomicity across objects:

- **Fork into a new repo** (`POST /v1/repos { from: { repo, version } }`): the source is a *version*, immutable, so
  the new repo's object just sets `main` to that tree; nothing in the source changes, and a source deleted a moment
  later leaves the version reachable from the new repo's ref (objects are unowned; the mark walks every repo's refs).
- **Cross-repo `commit … from: { repo, version, path }`** and **merge from another repo's version**: again a read of
  an immutable version plus one CAS on the target; the only cross-object fact is that the referenced objects stay
  alive, which the `touch` on reference-by-id guarantees across the GC's mark.

Everything else (a mount of several repos, a workflow owning branches in several repos, an export) is a sequence of
single-repo operations; a failure between them leaves each repo consistent and a ref unmoved, never half-moved.
Nothing in the model requires two refs to move together.

## 7. What gets deleted, and the phases

**Deleted** (line counts from `main` at `17214fef`, 2026-11-13, from the Volumes inventory):

| area | files | lines |
|---|---|---:|
| Workers volume model | `volume.ts` (the DO, its twelve tables, the R2 `files/<tenant>/<volume>/<uuid>/<sha>` layout, snapshots, pins, forwarded pins, read-set claims, `gc_candidates`, the daily alarm, `camelfs_trees`), `volume-commit.ts`, `volume-policy.ts`, `file-upload.ts` | 1,061 + 125 + 58 + 84 |
| Workers routes, mounts, tools | `files.ts` (the twelve `/v1/volumes/*` routes, `handleAgentFilesRoute`, the Pi tools; ~400 lines of tool shape are rewritten over repos), `file-mounts.ts`, `file-links.ts`, `file-output.ts`, `file-versions.ts`, `tool-files.ts`, `tool-output-files.ts`, `fs-tools.ts`, `history-pins.ts`, `agent-workspace.ts` (the R2 fork-claim objects), the volume calls in `dreaming.ts` | 1,160 + 214 + 80 + 67 + 27 + 147 + 56 + 72 + 21 + 88 + ~70 |
| Quotas | `storage-quota.ts`, `tenant-storage.ts`, `storage-usage.ts` (the limit stays, counted in the repo object) | 29 + 116 + 177 |
| Workflows | `workflow-volumes.ts`, `workflow-forks.ts`, the fork-ownership half of `workflow-results.ts`, the `keep()` volume writes and `pushSpec` in `workflow-jobs.ts`, the `childVolume`/adopt paths in `workflow-object.ts` | 115 + 62 + ~100 + ~60 + ~40 |
| Jobs | `jobs/camel-sync.ts`, `jobs/host-sync-store.ts`, `jobs/camelfs.ts` (the import bridge), `JobSpec.volume`, `WireJob.files`/`sync`, `HostJob.files/fetch` and the `/v1/internal/job-hosts/sync/*` route, `pullFiles` and the guest `files` op past inline sizes | 150 + 37 + 82 + ~200 |
| Node backend | `src/volumes.ts`, `src/volume-tools.ts`, `src/volume-env.ts`, `src/tool-files.ts`, `src/file-arguments.ts`, `src/core/file-arguments.ts`, `src/files.ts`, `src/storage-gc.ts`, `src/storage-usage.ts`, `src/storage-integrity.ts`, `src/gc-verify.ts`, `src/pin-backfill.ts`, `src/computers/transfers.ts`, `scripts/{backfill-pins,check-storage,reconcile-storage,verify-gc}.ts` | 1,192 + 406 + 150 + 314 + 106 + 103 + 278 + 115 + 175 + 85 + 94 + 86 + ~300 |
| Daemon (proto-block's count) | `internal/refs/refs.go` and the `refs` table, the `job/<id>` ref creation in the tree-form mount, `POST /v0/forks`, the renew goroutine (~250 lines, one table); the import bridge `api/objects.go`, `client/trees.go` and the request handling of `objects.go` (~580 lines). The tree builder (~150 lines: trie → git-exact tree bytes, subtree reuse) and blob upload stay; so do `mounts`, `tree_roots`, `lineage_blobs`, `uploaded` and unit 8's `chunk_locations` as host-local cache | ~830 |
| Other Workers callers | `apply.ts` and `shared/apply.ts`'s keyed-volume creation, `computers/objects.ts:334` seeding and `computers/policy.ts`' volume text, `media/images.ts:285–344` and `media-api.ts`'s `volumeId` fields, `model.ts`'s R2-key decoding for image inputs, `channels.ts`' volume file routes, `prompt-attachments.ts`' pin calls, `hosted-mcp-tools.ts`' mounts schema, `account-export.ts`/`account-deletion.ts`/`account-lifecycle.ts`'s volume walks, `admin/admin-usage.ts`' volume counts | ~600, rewritten over repos |
| Clients and console | `clients/projects.ts`, `clients/python/camelai_run/projects.py` (dropped outright); `VolumeHandle`, `AgentFiles`' volume paths, `FileUrlClaims` in `clients/server.ts`, Python `Volume` (rewritten as `RepoHandle`); `console/web/pages/volumes.tsx`, `components/files.tsx` (rewritten over repos); `evals/workflows/lib/runtime.ts`, `choice.ts`, `run.ts` (over `RepoHandle`) | 203 + 176 + ~500 + 145 + 233 + ~150 |
| Schema and docs | migrations to retire: `volumes`, `volume_snapshots`, `volume_watchers` (001), `storage_usage` (012), `storage_gc`/`chunk_touches`/`chunk_pins` (026), 058, 060, `agent_dreaming.volume` (129); OpenAPI's twelve volume paths and eighteen file/volume/snapshot/mount schemas (~1,000 lines); `docs/guides/files.md` "Volumes", `projects.md`, and the volume sections of `limits.md`, `errors.md`, `persistence.md`, `privacy.md`, `billing.md`, `apply.md`, `workflows.md`, `multi-agent.md`, `computers.md`, `tools.md`, `concepts.md` | rewritten |
| Tests | `tests/volumes.test.ts` 778, `volume-commit` 140, `volume-env` 172, `storage-gc` 217, `prop-storage-gc` 218, `storage-limits` 178, `storage-integrity` 57, `storage` 179, `gc-verify` 56, `projects` 223, `files` 351, `tool-files` 282, `file-arguments` 295, `file-link-tools` 144, `purge` 214; Workers `volume-commit.integration` 278, `files.integration` 258, `file-*` 253, `tenant-storage` 93, `host-sync-store` 30, `camelfs-import` 127, `workflow-jobs` 407, `workflow-results` 122, `computer-fork` 190; the volume sections of `tests/python_sdk.py`; `tests/sim/corpus/storage.json` | ~5,300, rewritten over repos |

About **4,900 lines** of volume code go on Workers, **3,400** on Node, **830** in the daemon and **1,250** in clients
and console, plus the schema, docs and ~5,300 lines of tests that follow them. What replaces them is the repo object
(~800), the files API over it (~600), the tools rewrite (~400) and the SDK, console and OpenAPI rewrites, on top of
`camelfsd` and the storage plane, which already exist.

**Phases** (each a PR stack onto the integration branch `camelfs/files-model`, each usable alone and stated by its
bar, not a date: Miguel wants fast iteration, and the three lanes of §9 build in parallel; v0's ledger continues
throughout):

1. **The repo object and the API**: `RepoDO` with refs, fence, quota counters, head-tree cache; the
   object store writers for trees, commits and blobs from Workers; `/v1/repos/*` including files, `files:batch`,
   `commit`, `history`, `diff`, `restore`, `branches`, `merge`; tokens; the Pi file tools over repos for agents
   without a VM (every write a commit); `checkpoint(message)`, `restore`, `history`, `diff` as tools; the edge cache
   on `blobs/:sha`. New agents get repos; nothing else changes yet.
   Bar: a Worker file write ≤ 80 ms p50; `files:batch` of 20 files ≤ 150 ms; fork ≤ 50 ms; merge of 3 disjoint
   edits ≤ 200 ms; `history`/`diff` ≤ 100 ms at 50k files.
2. **Hosts, jobs and workflows on refs**: `camelfsd` takes its CAS from the runtime and drops its ref
   store; `job({ at: ref | version, commit })` mounts the tree with no import; the `job/<id>` branch, merge and
   fast-forward effects; result cache on the tree; `keep()` as one commit; computers mount the agent's ref with the
   lease (per camel-fs.md phase 2). The import bridge and `camel-sync` are deleted.
   Bar: job placement → first command ≤ 300 ms warm with no import leg (ledger L25, L43, L68 close); result leg
   (L70) ≤ 300 ms; a commit job's branch merges or fast-forwards in one effect.
3. **Everything Volumes did**: the published-ref pattern as an SDK example (projects and `publishTool`
   deleted); uploads and attachments as commits with the history ref; dreaming on a repo; signed links on blobs and
   versions; `notify` from the repo object; account export (tar + bundle) and deletion by refs; quota and billing
   from the repo object's counters; `grep` on the index for every agent; the console's repos page; SDKs and OpenAPI;
   the guides.
   Bar: the publish pattern's check-and-move round trip ≤ 1 s for a 5k-file repo; export of a tenant with 100 repos
   streams without buffering; a deleted tenant's objects are unreachable within one GC cycle.
4. **Delete**: the Volume DO, the R2 layout, the Node volume files, the routes, the schemas, the console pages, the
   fakes; the ledger rows they carried flip to `fixed`. Bar: no reference to `VOLUMES`, `vol_` ids, `files/<tenant>/`
   keys or `chunks/<tenant>/` keys remains in either backend; the integration branch merges to `main`.

**Later** (not in scope): migration of existing volumes into repos (one commit per volume from its file table,
a `published/<n>` ref per pinned snapshot, keyed ids preserved), done lazily on first touch or by a sweep when the
new model has run for a while.

## 8. Decisions taken by default (Miguel may override)

Miguel is not reviewing tonight and wants this built, so each remaining question is decided as recommended and
marked **default**; a reversal is a small change to the named section. Already decided by Miguel, and written as
such above: the state split (§6) and dropping projects and `publishTool` (§5).

1. **The word: `repo`** (default). It names the API path (`/v1/repos`), the SDK handle (`RepoHandle`) and every doc.
   Developers already know that a repo has branches, history, forks, diffs and restores; "workspace" collides with the
   agent's own mount. Override cost: a rename.
2. **Every API write is a commit** (default). Per write, under the decided split: one blob PUT to S3 ($5 per
   million, $0.000005), about four tree writes and one commit write to DynamoDB (1–3 KB each, so ≈ 10 write units at
   $1.25 per million, $0.0000125), and one `RepoDO` CAS (one DO request at $0.15 per million plus ~3 SQLite rows at
   $1 per million, $0.0000032): **≈ $0.0000207 per write**, so the 144 M writes a month of camel-fs.md's 1,000-agent
   baseline cost **≈ $3,000/month**, falling to ≈ $1,800 with tree segments (one item per write's trees). Tonight's
   S3-only variant is ≈ $0.000033 per write (six PUTs plus the CAS), ≈ $4,800/month. The alternative, coalescing a
   VM-less agent's writes within a turn into one commit at turn end, would cut the write line ~5× (to the ~20
   checkpoints an hour the VM path pays) and lose per-write history and blame. Default: every write, with `commit`
   for multi-file tools. Override cost: a turn-end coalescer in the files API; §3 and §2 change, §9 does not.
3. **Published versions are refs** (default): `published` (or `published/<n>`) and `release/<label>` replace pinned
   snapshots and labels; a repo with thousands of publishes has thousands of refs, which the repo object's SQLite
   holds without strain and `refs?prefix=published/` lists. Override: a single `published` ref whose tree is a
   manifest of versions.
4. **The history ref keeps** (default): every version an agent's transcript shows stays reachable for the agent's
   life, today's rule ("a file an agent was sent or shown stays until the agent is deleted"), so `rm` or `restore` on
   `main` never breaks a message that showed a file. Override: let `main` win and have the transcript's link fail.

Not a question any more: the edge cache's trust boundary is settled by §3 and §9.1 (authorization by `(version,
path)` before any lookup by hash). camel-bots' move off project snapshots is migration, later (§5).

## 9. The storage-plane contract: what `camelfsd` exposes to the runtime

This section is the build contract for three lanes working in parallel: the runtime's repo object and files API
(`wf-repos`), the daemon (`proto-block`), and jobs and hosts (`wf-delegation`). It is the exact HTTP API `camelfsd`
serves to the runtime over the `CAMELFS` VPC binding (one named tunnel to the host's `127.0.0.1:8790` tonight; the
API tier of camel-fs.md §1.6 later), plus the two host-side calls that change. Everything else about the daemon
(mount, fork, release, the cache, the lazy origin, hydration, packs) is unchanged and stays on the host's Unix socket.

**Division of ownership.** The repo object (`RepoDO`) owns refs, their log, leases and fences, the head-tree cache,
quota counters and watchers, and performs every CAS. `camelfsd` holds **no refs**: it stores and serves immutable,
content-addressed objects (blobs, trees, commits, chunks, roots, shards) and computes over them (commit, diff,
merge, grep, read). The runtime is the authorizer; the daemon enforces lineage scoping and the (tree, path) rule
below, and trusts nothing it is told about hashes.

**Tonight's storage.** Trees and commits are written durably to S3 by `camelfsd` (`t/<sha1>`, `k/<sha1>` beside
`o/<sha1>` blobs and `c/<sha256>` chunks) before any call returns. DynamoDB for trees and commits stays the decided
target (§6) and starts when Miguel creates the table; it is a storage-layer swap inside the daemon, invisible to this
contract (ledger L74). The daemon's own SQLite ref store (`internal/refs`, the `refs` table, `POST /v0/forks`) goes;
its host-local tables (`mounts`, `tree_roots`, `lineage_blobs`, `uploaded`, `chunk_locations`) stay as cache.

**Conventions.** JSON over HTTPS; ids are hex (`blob`, `tree`, `commit`: git SHA-1; `root`, chunk: sha256).
`Authorization: Bearer <token>` (one shared bearer tonight, the daemon listening on `127.0.0.1:8790` behind the
`CAMELFS` tunnel with `--listen-api`; runtime-signed scoped tokens later). `Idempotency-Key` on every write: the
daemon stores `key → response` and replays it, so a retry returns the first answer. Errors on these `/v1` routes are
`{ "error": { "code", "message", "details"? } }` with the codes in 9.8; the host socket's `/v0` routes keep their
current `{ error, detail }` shape tonight because `jobhost` parses it. Sizes in bytes. Paths are lineage-relative,
normalized, no leading slash.

**Lineage and reachability.** Every route is scoped by `lineage` in the path. A lineage is a string `RepoDO` assigns
at repo creation, `<tenant>:<root repo id>`, and **a fork into a new repo inherits its source's lineage** (wf-repos),
so forks share one object set and a fork is O(1) in objects as well as in refs; a repo made from scratch starts a new
lineage. The daemon records every object it writes for a lineage, trees **including subtrees** (listings hand out
subtree ids) and blobs alike, in `lineage_objects`, and refuses any reference the lineage has not written or
imported, with `404`/`400`, never "exists but not yours". A cross-lineage reference (`commit … from: { repo,
version, path }` across tenants' repos, or any other) is, tonight, a read followed by a `PUT` of the bytes into the
target lineage; an `adopt` call that grants reach without copying is a later, low-priority addition.

### 9.1 Blobs

`PUT /v1/lineages/{lineage}/blobs` with the raw bytes as the body (`Content-Length` or chunked, up to the single-PUT
cap of 5 GiB; the daemon streams to a temp file and does one S3 PUT, so the old 256 MiB cap goes; multipart later),
optional `X-Camel-Sha256` to let the daemon refuse early on a mismatch.
→ `201 { "blob": "<sha1>", "sha256": "<hex>", "size": 1234 }`. The daemon hashes what it receives (both ids),
writes `o/<sha1>` if absent, records the blob in the lineage's set, and answers; a repeat PUT of the same bytes is a
no-op `200` with the same body. The caller never supplies the blob id.

`GET /v1/lineages/{lineage}/blobs/{blob}?tree=<tree>&path=<path>` → the bytes (`Content-Type` sniffed or stored,
`Range` honoured, `X-Camel-Blob`, `X-Camel-Size`). **Authorization rule:** a blob is served only when the request
proves the caller's repo reaches it: `tree` must be a tree of this lineage and `path` must resolve in it to exactly
`{blob}`; otherwise `404 not_in_tree`, whether or not the bytes exist. There is no read by hash alone, because
hashes leak (listings, git edges, logs, URLs, errors) and a known-content hash would confirm a file's existence in
another tenant. The runtime's edge cache may still be keyed by `blob` **after** this check has passed in the Worker.

### 9.2 Batch read

`POST /v1/lineages/{lineage}/read` `{ "tree": "<tree>", "paths": ["a/b.ts", "c.md"], "maxBytes"?: 67108864 }`
→ `200`, `multipart/mixed`, one part per path in request order: headers `X-Camel-Path`, `X-Camel-Blob`,
`X-Camel-Mode`, `X-Camel-Size`, body the bytes; a path that does not resolve is a part with `X-Camel-Error:
not_in_tree` and no body. Limits: 256 paths, 64 MiB total (`413 too_large` with the first offending path). The same
(tree, path) rule as 9.1 applies to every part; the daemon fetches from S3 in parallel.

### 9.3 Commit

`POST /v1/lineages/{lineage}/commits`
```json
{ "parents": ["<commit>", "<commit>"?], "baseTree": "<tree>" | null,
  "changes": [ { "path": "src/a.ts", "blob": "<sha1>", "mode": "100644" },
               { "path": "bin/run", "mode": "100755" },
               { "path": "old.txt", "delete": true } ],
  "author": "agent:ag_123", "message": "turn 14", "time": 1763046000,
  "trailers": { "Camel-Agent": "ag_123", "Camel-Run": "run_9", "Camel-Turn": "14", "Camel-Call": "call_7",
                "Camel-Checkpoint": "api" } }
```
→ `201 { "tree": "<tree>", "commit": "<commit>", "parents": [...], "time": 1763046000, "changed": 3, "bytes": 4096 }`
(so the repo object's commit index needs no follow-up `GET`). Rules: `parents` is a list (`[]` for a first commit;
two for a merge); `baseTree` defaults to `parents[0]`'s tree (the empty tree when there are none), and a **merge
commit** is `parents: [ours, theirs]`, `baseTree` = 9.5's merged tree, `changes: []`; **`changes: []` is allowed**
(a `checkpoint(message)` on an unheld ref, or a `restore`, whose `baseTree` is the old version's tree); every `blob`
named must already be in the lineage (from 9.1 or an earlier tree of this lineage), else `400 unknown_blob`; a
`mode`-only change keeps the blob; a `delete` of a missing path is a no-op; the new trees (only those on changed
paths), the commit (git's bytes, `committer camelfs`, the trailers in the message) are written to S3 **before** the
response. `time` (unix seconds) is chosen by the runtime and is part of the commit, so the commit id is a pure
function of the request and a retry with the same body reproduces it; a retry with the same `Idempotency-Key` is
replayed regardless. The tree id is deterministic either way. Caps: 10,000 changes per call (`413`). The daemon does
not move any ref; the caller performs `RepoDO.cas(ref, expect, commit, fence, root?)` next.

### 9.4 Trees, commits, diff

`GET /v1/lineages/{lineage}/trees/{tree}?path=<dir>&recursive=0|1&after=<path>&limit=10000`
→ `{ "entries": [ { "path": "src/a.ts", "mode": "100644", "blob": "<sha1>", "size": 1234 }, … ], "next"?: "<path>" }`
(directories as `{ "path", "mode": "040000", "tree": "<sha1>" }` when not recursive).

`GET /v1/lineages/{lineage}/commits/{commit}` → `{ "tree", "parents": [...], "author", "message", "trailers": {...},
"time" }`.

`GET /v1/lineages/{lineage}/diff?from=<tree>&to=<tree>&path=<prefix>` →
`{ "changes": [ { "path", "status": "added" | "modified" | "deleted" | "mode", "oldBlob"?, "newBlob"?, "oldMode"?,
"newMode"? } ] }`, O(changed), descending only into subtrees whose ids differ.

### 9.5 Merge

`POST /v1/lineages/{lineage}/merge` `{ "base": "<tree>", "ours": "<tree>", "theirs": "<tree>", "mode": "merge" |
"squash" }` → `200 { "tree": "<tree>", "merged": ["a.ts"], "took": { "ours": 3, "theirs": 5 } }` when clean (the
daemon writes the merged trees and any diff3-merged blobs to S3; the caller makes the commit with 9.3 and the CAS),
or `409 conflict` with `{ "conflicts": [ { "path", "base"?, "ours"?, "theirs"?, "reason": "both_modified" |
"delete_modify" | "binary" | "mode" } ] }` and nothing written (merged blobs go to a temp directory first). Whole
subtrees are taken by id where only one side changed; co-edited text files go through diff3 on lines (the daemon
shells out to `git merge-file -p`, git being on the host); a file with a NUL in its first 8 KiB is binary and a
`binary` conflict when both sides changed it; renames are not detected (the git edge's `merge-tree` is the later
option).

### 9.6 Grep

`GET /v1/lineages/{lineage}/grep?tree=<tree>&q=<text>&regex=0|1&ignoreCase=0|1&path=<glob>&limit=2000&context=0`
→ `{ "matches": [ { "path", "line": 42, "text": "…", "before"?: [...], "after"?: [...] } ], "files": 17,
"truncated": false, "indexed": "scan" | "shards" }`. **Tonight it is a scan**: the daemon has no shard indexer
(that is `proto/search`'s `camelsearch`, not yet integrated; ledger L77), so it runs the pattern over the tree's blobs
in parallel, cache first and S3 at 64 in flight, with this exact response shape and `"indexed": "scan"`: sub-second
warm on the medium tree, about the NIC time cold on 500 MB. When the trigram shards of camel-fs.md §1.7 are wired
in, the same call answers from them with `"indexed": "shards"`. A match cap of 2,000 is the only limit.

### 9.7 Host-side calls that change

Over the host's Unix socket (unchanged transport), two calls change shape because the daemon no longer owns refs:

- `mount { jobId, lineage, tree, fence: { holder, epoch } | null, ... }` → `{ image, warm, mountMs }`: the fence is
  what the runtime's lease handed the host; the daemon **stores and echoes it and does not check it** (the runtime's
  CAS does); `null` means a read-only `root`-form mount that refuses checkpoints with `no_fence`. The mount no longer
  creates a `job/<id>` ref or takes a lease; the daemon's `heartbeat` route and renewal goroutine go (the runtime
  owns renewal, heartbeat and takeover; the 30 s heartbeat from #914 stays on the jobhost → runtime path). What
  stays: the tree → root lookup (`tree_roots`), the nearest-ancestor base, the blank image and the guest apply.
- `checkpoint { mount, message, trailers, time }` → `{ tree, root, commit, timings: { walkMs, streamMs, freezeMs,
  reflinkMs, fiemapMs, hashMs, uploadMs, imageMs, wallMs } }`: the daemon runs the §1.3 contract of camel-fs.md,
  writes blobs, trees, the commit and the root to S3, and returns; **it performs no CAS**.

**Who performs the CAS, and when** (wf-delegation): the lease and the fence are the runtime's from the start.
Before dispatch, `HostJob` creates the branch `job/<id>` at the version the job mounts (`branch(job/<id>, from:
version, owner: job)`; for inline `files` that version is the scratch commit of §4), takes the lease on it from
`RepoDO`, and puts `fence { holder, epoch }` into `WireJob.camelfs`; `jobhost` passes the fence to `mount`. A lease
is capped at 10 minutes, so `HostJob` renews the `job/<id>` lease from its alarm every TTL/3 for the job's
lifetime (agreed between wf-delegation and wf-repos); a renewal that finds the lease taken over fails the job's
CAS later, never silently. Then:

- **Jobs** checkpoint once, at the end, and the VM is destroyed right after, so there is no later reader of the
  guest's index: `jobhost` sends `checkpointed { tree }` to the guest as soon as the daemon answers, and **`HostJob`
  performs `RepoDO.cas("job/<id>", expect = the mounted version, commit, fence, root)` when the result arrives**, with
  no synchronous round trip inside the checkpoint. A failed CAS becomes the job's `checkpointError`
  (`"cas: <reason>"`) and the rest of the job's output stands. `HostJob` is already the durable owner of the
  dispatch (ledger L72).
- **Computers** (per-turn checkpoints in a long-lived VM) need the synchronous form: `jobhost` → runtime
  (`RepoDO.cas`) → `jobhost` → `checkpointed { tree }` or `checkpointed { error }`, a WebSocket request with an id and
  a reply, so the guest's index commits only after the ref moved. That is phase 2's computer mount, not tonight.

`RepoDO.cas` accepts the checkpoint's `root` so a later job at that version mounts warm without the daemon rebuilding
the image; the ref record carries `root?` (§6).

### 9.8 Errors

| code | HTTP | when |
|---|---|---|
| `invalid_request` | 400 | malformed JSON, bad id, unnormalized path, unknown mode |
| `unknown_blob` / `unknown_tree` / `unknown_commit` | 400 | an id the lineage cannot reach is named in a write |
| `not_in_tree` | 404 | a read whose (tree, path) does not resolve to the requested blob, or a tree this lineage does not have |
| `blob_mismatch` | 400 | `X-Camel-Sha256` did not match the bytes received |
| `too_large` | 413 | a blob over the single-PUT cap, a batch over 256 paths or 64 MiB, a commit over 10,000 changes |
| `conflict` | 409 | a merge with conflicts (body lists them) |
| `no_fence` | 409 | a checkpoint on a mount without a fence |
| `unavailable` | 503 | S3 or the host's store unreachable; safe to retry with the same `Idempotency-Key` |

Every error is loud and specific; nothing degrades to empty data. The daemon logs lineage, ids and sizes, never
paths' contents.
