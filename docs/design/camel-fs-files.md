# camelRun's file model: repos, refs and trees, and nothing else

Status: design, 2026-11-13, for Miguel's review. Docs only. Miguel: "assume we're redesigning the system entirely
and remove concepts like the Volumes entirely. We'll figure out how to migrate." This document is that redesign:
camelRun's file model with camelFS ([camel-fs.md](camel-fs.md)) as the **only** concept. Volumes are gone. There is
no back-compat, and migration is out of scope except for one note at the end.

**Decided (Miguel, 2026-11-13 ~17:00): option C.** camel-fs is one AWS service, `camelfsd --role api`, a stateless
Go tier in us-west-2 holding refs, leases and fences as DynamoDB conditional writes and the objects in DynamoDB and
S3. Hosts run `camelfsd --role host`, and the runtime holds no ref. `RepoDO`, the tunnel and the shared bearer go.
§6 has the state split and §9 the contract; the sections in between say "the tier" where they said "the repo
object".

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
| **ref** | a named, mutable pointer to a version; `main` by default; others for attempts, published versions, mirrors; every ref has an owner and dies with it. **Names** are `[A-Za-z0-9._-]` segments joined by `/` (`main`, `job/<id>`, `fork/<effect>`, `published/<n>`, `release/<label>`, `snap/<name>`, `dream/<key>`, `mirror/github/<branch>`), never a colon, no segment ending in `.lock`, at most 200 characters. The tier has no encoding of names, so a name that does not fit is refused, never rewritten: a cache ref is derived as `cache/<sha256(key)[:32]>` because cache keys carry arbitrary characters, and `mirror/github/<branch>` takes the GitHub branch name only when every segment is in the alphabet; a branch with other characters, a `.lock` segment or over the length is refused at mirror setup with a clear error. **Owners** keep their colons and come from a fixed prefix set, `(agent|workflow|job|user|api|cache):<id>`, which the tier enforces on every branch create (§9.9) | *branch* in the API where a user names one; `main` otherwise |
| **version** | an immutable commit: a tree id (git-compatible), parents, author, message and the attribution trailers; the id every cache, diff, mount and restore names | **version** |

Recommendation on the word: **repo**. Developers already know that a repo has branches, history, forks, diffs and
restores, which is exactly the surface; "workspace" collides with the agent's own mount, and "lineage" is a storage
term. A repo need not contain code: a shared docs folder is a repo with one branch.

**The API** (`/v1/repos`, replacing all twelve `/v1/volumes/*` paths):

| call | does |
|---|---|
| `POST /v1/repos { name?, key?, from?: { repo, ref? \| version? }, template? }` | creates a repo (idempotent by `key` or `Idempotency-Key`); `from` makes it a fork of another repo's version (O(1): the new repo's `main` points at that tree, nothing is copied); `template` seeds a first commit |
| `GET /v1/repos`, `GET /v1/repos/:id`, `DELETE /v1/repos/:id` | list, inspect (`{ id, name, key, refs, bytes, files, createdAt }`), delete (every ref goes; objects follow by reachability) |
| `GET /v1/repos/:id/refs`, `PUT /v1/repos/:id/refs/:name { version, expect? }`, `DELETE …/refs/:name?expect=` | the refs; `PUT` is the one mutation primitive underneath everything else, a CAS on `expect` (§9.9's `cas`) under the ref-move rules (§6): a new commit's first parent is the current version, a move to a recorded commit is a fast-forward, and a rewind is a `restore`, a new commit |
| `POST /v1/repos/:id/branches { name, from?: ref \| version, owner?, ttl? }` | an O(1) branch inside the repo (shares chunks on hosts); `owner` ties its life to a workflow, job or agent |
| `GET /v1/repos/:id/history?ref=&after=&limit=&path=` | first-parent history, with `merges: true` to descend into attempts; the repo's only log (§6: there is no separate `log` route or event store) |
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

Served by the camel-fs tier (§9; the public `/v1/repos` moves onto it in build step 5 of §6). The runtime calls the
same API for its agents and keeps each agent's tree cache (§6). Access is by token: a repo token names `{ repo, read: [ref globs], write: [ref globs],
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
| `GET …/blobs/:sha?version=&path=` | the bytes of a content id, **immutable and cacheable forever**, and the edge-cache path: the Worker first checks that the caller's repo reaches the blob (`path` resolves in `version`'s tree to exactly `sha`, confirmed by the agent's tree cache or by the tier, §9.1), **then** looks the bytes up in the Cloudflare Cache API by `sha` and fetches from the daemon on a miss. The cache stays shared across repos, forks, agents and tenants because it is keyed by content, but no request is served on the strength of knowing a hash: hashes leak through listings, git edges, logs, URLs and errors, and a known-content hash must never confirm a file's existence in another tenant. A request without a resolving `(version, path)` is `404` whether or not the bytes exist |
| `POST …/links { path \| blob, method, expiresIn?, maxBytes?, contentType? }` | a signed URL for one download or one upload (an upload lands as a commit on the ref named at signing); today's `file_link`/`file_import` builtins keep their shape |

Consistency: a version is immutable, so anything read by `version` is exact and cacheable; a read by `ref` is the
ref's version at request time; a held ref's reads are its last checkpoint unless `consistency=live` forwards to
the holder. Writes to a held ref are forwarded to the VM and are durable at its next checkpoint; the response says
so (`landed: "forwarded"`).

## 4. Jobs and workflows

`job({ at: { repo, ref?, version? }, commit?: true | { onto: ref } })`. `at` is a place in a repo, the same shape as
`POST /v1/repos`' `from` (§1): `repo` is the repo id, and at most one of `ref` (a name, default `main`) or `version`
(40 hex) picks the version; a bare ref or version means nothing without its repo, so neither is accepted alone
(wf-delegation, 2026-11-13). The host mounts the version's tree as the job's `/repo`
(a reflink of the image when warm, the lazy origin when cold; camel-fs.md §1.3) on a `job/<id>` branch of the
repo. Nothing is imported, synced or snapshotted: there is no per-job import (`/v0/trees`, `/v0/blobs`, the
`camelfs_trees` cache, the pinned volume snapshot) and no snapshot cache, because the tree the job wants is already
an object in S3 and the ref already names it.

A **commit job** checkpoints `/repo` at its end, **even when the command fails** (the exit status is in the
commit), and the branch `job/<id>` then points at the result. The workflow decides what happens to it:

- `merge(into: "main", from: job.branch)`: the three-way merge; clean → one commit on `main` with two parents (the
  attempt's history stays reachable and attributable), conflicts → `{ conflicts }` for a fix stage, which edits the
  same branch and merges again;
- `fast-forward` when `main` has not moved: the ref moves, zero bytes (ref-move rule 2, §6);
- or nothing: the branch is owned by the workflow and dies with it.

The host's result (`WireResult.camelfs`: `tree`, `root`, `commit`, `checkpointError`, the timings) stays as the
transport and becomes the `job/<id>` branch's version plus its timings in the job result; `WireResult.camelfs` is
not a public shape.

**Inline files.** `job({ files })` and the agent's `job_run({ files })` (a job with a few inline files and no repo)
become **one path**: the runtime commits the inline files onto a scratch `job/<id>` branch of the caller's repo (the
workflow's repo, keyed `workflow:<id>`, or the agent's workspace) and the job runs at that ref like any other; the
guest `files` op and `WireJob.files` go. Default (wf-delegation's recommendation), Miguel may override. During the
cut-over a plain string `at` still means a volume id, until the deletion phase removes volumes.

**The agent's `job_run` tool** gains the same `at: { repo?, ref?, version? }` and `commit` as `job()`, with `repo`
defaulting to the agent's own workspace, and its model-facing text changes from "`at` (a volume id) starts it with
that volume's files … (changes are not saved back)" to "`at` picks the version to start from: `ref` (a branch name,
default `main`) or `version`, in your workspace unless `repo` names another; with `commit: true` the job's `/repo` is
saved as a version you can `restore` or merge". That text is model-facing and is reviewed line by line, like `checkpoint`'s.

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
| **`notify`** on a mount (prompt the agent when others change files) | the tier sends a signed webhook when a watched ref moves, landing as an outbox row (§9.11); the same coalescing |
| **Console** (`pages/volumes.tsx` 145: list, create, delete volumes and snapshots; `components/files.tsx` 233: the file browser with list, upload, delete and signed-URL preview over `/v1/volumes/:id/files`; per-mount browsers in `agent.tsx`; counts in `account.tsx`) | a repos page: refs, history (first-parent, with attribution), a tree browser at any version (the file browser reads `files?version=` and previews through `blobs/:sha`), diff, restore, grep; the per-mount browser on the agent page points at the mount's repo and ref |
| **`push()`** (`workflow-jobs.ts` `pushSpec`: a job whose `at` is the volume to push, with the GitHub token in the job's process) | the git edge's mirror (camel-fs.md §1.8) from a ref, with the App token the runtime mints; no job (§4) |
| **`apply`** (declarative provisioning: `shared/apply.ts`, `apply.ts`, `apply-api.ts` create keyed volumes, cached per apply run) | an `apply` manifest names repos by key (`repos: [{ key, template? }]`); the same create-by-key, idempotent; mounts in manifests name `{ repo, ref? }` |
| **Computers** (`computers/objects.ts:334` seeds a container from `inlineFiles` or `volumeFiles()` through `camel-sync`; `computers/policy.ts:30` and the `agent-tools.ts` computer text tell the model to `cp` results to a volume; Node `computers/transfers.ts` moves files volume ⇄ computer, 256 MiB) | a computer **mounts the agent's repo ref** as its disk (camel-fs.md §1.5), so there is nothing to seed or transfer: files written in the machine are commits at the turn checkpoint, and files written through the API appear in the machine; the model-facing computer text drops "cp to a volume" (reviewed line by line); `transfers.ts` goes |
| **Agent fork of a workspace** (`agent-workspace.ts`: an R2 fork-claim object, `claimReadSet`/`copyReadSet` on the source workspace, `releaseReadSet("fork:<id>")`) | `POST /v1/repos { from: { repo: parent workspace, version } }` at the parent's current version: O(1), no claim, no copy; the child's history ref starts as the parent's (§2) |
| **Images and media** (`media/images.ts:285–344` saves generated images to a volume when `volumeId` is given; `media-api.ts` takes and returns `volumeId` + `path` for images and transcriptions; `model.ts` ~81 reads image inputs for the model by decoding R2 `files/<tenant>/<volume>/…` keys) | the media API takes and returns `{ repo, ref?, path }` and `{ repo, version, path, blob }`; a generated image is a commit; the model layer reads an image input as a blob by `(repo, version, path)` through the files API, never by storage key |
| **Channels** (`channels.ts` mounts, reads and signs links to volume files for channel messages, through `handleAgentFilesRoute` and `signVolumeLink`) | a channel attachment lands like an upload (a commit under `uploads/<request>/`); outgoing files are signed links to `(version, path)` |
| **MCP `add_schedule` mounts** (`packages/cli/src/tools.ts:196`, `hosted-mcp-tools.ts:197`: the mounts schema names `volumeId`) | the schema names `{ repo, ref?, path, mode }`; nothing else changes |
| **Evals** (`evals/workflows/lib/runtime.ts`, `choice.ts`, `run.ts` create volumes, write files, mount them, snapshot through the SDK) | the same through `RepoHandle`; the eval corpus is a repo per case made by key, forked per run |
| **Admin usage** (`admin-usage.ts` on both backends counts volumes and storage per tenant) | counts repos, refs and stored bytes from the `lineages` items' counters |
| **Tool-result file shapes** (`file-output.ts`: `PresentedVolumeFile` / `WrittenVolumeFile` with signed links, the shape tool results use to hand files back) | `PresentedFile { repo, version, path, blob, size, link }`; the pinning half (`file-pin-volumes`, `releasePresentedFiles`) is the history ref |
| **SDKs** (`VolumeHandle`: `info delete snapshot snapshots updateSnapshot deleteSnapshot archive restore commit fork changes list write read readText readAll`; Python `Volume`, `create_volume`, `read_all`) | `RepoHandle`: `info delete refs branch merge history diff blame restore commit write read readText list readAll export grep`; `agents.runtime.repos.create/get/list`; Python mirrors it; `projects.*` keeps its surface over repos |
| **OpenAPI** (`/v1/volumes/*` twelve paths; schemas `Volume`, `VolumeFile`, `VolumeInput`, `VolumeSummary`, `Snapshot`, `SnapshotInput`, `SnapshotMade`, `SnapshotUpdate`) | `/v1/repos/*`; schemas `Repo`, `RepoFile`, `RepoInput`, `Ref`, `Version`, `Commit`, `Diff`, `Blame`, `MergeResult` |

## 6. Where state lives

**Decided (Miguel, 2026-11-13 ~17:00): option C, camel-fs as one AWS service.** It replaces the earlier split of
the same day, in which refs, the ref log, leases and fences lived in a per-repo Durable Object (`RepoDO`). The
study behind it is the C-against-D comparison (C: one AWS service; D: `RepoDO` on a camel-fs Worker in front of a
regional storage tier). The state is now:

| what | where | key |
|---|---|---|
| refs, leases, fences, watchers | DynamoDB `refs`, one item per ref | partition `lineage`, sort `name` |
| lineages: tenant, kind, default branch | DynamoDB `lineages` | `lineage` |
| trees and commits (git's bytes, git's ids; ≤ 400 KB items, an S3 stub past that; cold generations packed to S3 `g/`) | DynamoDB `objects` (S3 `t/`, `k/` until the table exists, ledger L74) | `lineage`, `id` |
| pending deliveries (`notify`; compute's `vm.*` hints) | DynamoDB `deliveries` | `shard`, `id` |
| usage events (`usage.vm`, `usage.storage`), pulled by the runtime (§9.13) | DynamoDB `usage`, TTL 35 days | `shard`, `ulid` |
| blobs, chunks, roots, packs, search shards | S3, one bucket per environment, keys prefixed by lineage (§9) | `<lineage>/<kind>/<id>` |
| the NVMe cache of chunks, images, trees and shards | each host's `camelfsd --role host` | content hash |
| each agent's cache of tree contents | the agent's own Durable Object, by tree id | tree id |
| the per-tenant repo list; the token signing keys (`RuntimeSigner`, Postgres `signing_keys`) | the runtime | tenant |

**Deployed names** (fs-infra, #967, applied 2026-11-13; `infra/camelfs/README.md` is the source of truth). All
of these are in account `904534089871`, `us-west-2`, with state at `agent-runtime/camelfs/terraform.tfstate`.

- **Bucket:** `camelfs-prod-904534089871`. SSE-KMS, versioned with 35-day noncurrent expiry, daily Inventory
  into `inventory/`.
  - Keys: `<lineage>/{o,t,k,r,c,ts}/<hash>`.
  - The guest image (K1) at `guest/<sha256>…`, put only by the GitHub OIDC role
    `camelfs-prod-guest-image-publisher`.
  - VM results at `results/<lineage>/<vm>` (prefix first, so one 7-day lifecycle rule on `results/` expires them,
    no tags; #1003), written by the host and verified by the tier (camel-fs-compute.md §2). Deleting a lineage
    must cover `results/<lineage>/` as well as `<lineage>/` (ledger L102).
- **Tables** (on demand, PITR, deletion protection, no TTL, no indexes):
  - `camelfs-prod-objects` (`lineage` + `id`);
  - `camelfs-prod-refs` (`lineage` + `name`);
  - `camelfs-prod-lineages` (`lineage`);
  - `camelfs-prod-deliveries` (`shard` + `id`);
  - `camelfs-prod-hosts` (`pool` + `host`);
  - `camelfs-prod-vms` (`id`).
  - `camelfs-prod-usage` (`shard` + `ulid`), the one table with DynamoDB TTL (on `expiresAt`, 35 days), for §9.13;
    created and applied (fs-infra, #985).
- **Tier:** ECS Fargate (Graviton) service `camelfs-prod-api` behind two ALBs, both with HTTP/2 off: public
  `fs.camelai.dev` (Cloudflare ranges only) for the runtime, and internal `fs-internal.camelai.dev` (the hosts'
  security groups only) for the hosts' in-VPC calls. Hosts listen for the tier on `--listen-compute` port 8792.
- **Keys** (Secrets Manager):
  - `camelfs/prod/token-verify-keys`: the runtime's Ed25519 JWKS, injected as `CAMELFS_JWKS`.
  - `camelfs/prod/service-signing-key` and `camelfs/prod/service-verify-keys`: the tier → host token family's keys,
    retired by §9.12's mTLS (fs-infra removes them with the CA work).

  The api task role reads no secret.
- **IAM:** the host policy `camelfs-prod-host` allows the bucket and `objects` only. It explicitly denies every
  other table, so a host moves a ref only through the tier's fence check. Hosts write results under their
  existing bucket `PutObject`; #1003 removed #967's deny on results.

Nothing in the runtime holds a ref. `camelfsd --role api` is a stateless Go tier behind an ALB in us-west-2: the §9
plane plus a `refs` package, any node serving any request. Hosts run `camelfsd --role host` (the block layer and the
cache, no refs) and reach the tier in-VPC. The `CAMELFS` tunnel, the shared bearer (ledger L30) and `RepoDO` are
deleted. The reasons, from the study:

- **The ref-move rules are a storage condition.** Every move is one conditional `UpdateItem` on
  `version = :expect`, after the tier has checked the approved rules below against immutable commits: a new commit's
  `parents[0]` is the current version, and a move to a recorded commit is a fast-forward. A move can only land on
  the version it was checked against.
- **The dominant writer is a VM.** Per-turn checkpoints of `bash` VMs, computers and jobs are the writes that grow.
  Under C the host's CAS is in-region (checkpoint ≈ 170 ms + ≈ 7 ms to the tier and DynamoDB). Under D it would
  have travelled host → Worker → `RepoDO` → host (≈ 80–165 ms more on the per-turn path).
- **It stands alone.** One binary, a bucket and a table. Node, Workers, hosts and customers call one API with the
  same tokens. Self-host needs no Cloudflare. A runtime moved into AWS (celld) would be in-region on every path.
- **Hot lineages.** There is no serial owner per repo. A swarm's thousand forks are a thousand items in one
  partition key, which DynamoDB's adaptive capacity spreads; a single hot ref is the bound. A fork copies nothing,
  because head trees are cached by tree id (L78 goes away).
- **Cost is equal within the estimate:** ≈ 19.8–23.5 µ$ per write under C against 21.7 under D (§8).

What C costs, recorded: a foreign version (another writer's latest ref) and a notification cross clouds from a
runtime on Cloudflare, one round trip each (≈ 85 ms from an arbitrary colo, ≈ 25 from a DO placed `wnam`; both
estimates until measured). The agent's own reads stay local (below). The calendar is 4–5 weeks against D's 1.5–3,
and `RepoDO`'s internals freeze on day one.

**A ref item** holds `version` (the commit), `tree`, `root?`, `owner`, `expiresAt?`, `createdAt`, `createdBy`,
`updatedAt`, the lease (`holder`: host id, host boot epoch, mount id; `leaseEpoch`; `leaseDeadline`) and
`watchers` (a set of watcher ids).

**The ref-move rules** (wf-delegation's, lead-approved; the same as `RepoDO`'s CAS, and the tier's tests port its
tests):

1. **A new commit on an existing ref**: `parents[0]` is the current version, and `parents` has length 1, or 2 for a
   merge `[current, other]`. Otherwise `409 bad_parent` with `{ parents, current }`, and nothing changes.
2. **A move of an existing ref to an already-recorded commit** is fast-forward only. The tier walks breadth-first
   over all parents from the target, and at each visited version compares with the current version *first*, before
   requiring a commit record (so a fork whose base is a pre-fork version still fast-forwards). An unrecorded version
   that is not current is a dead end. If current is never reached, the answer is `409 not_fast_forward` with
   `{ current }`; past 50,000 visited it is `409 not_fast_forward` with `{ current, reason: "too_deep" }`, failing
   closed.
3. **The same version as current** is a no-op, and allowed.
4. **A ref that does not exist** (branch, create, seed) may be created at any commit.

Going back is never a move: `restore` is a new commit whose tree is the old version's and whose parent is current.
A stale `expect` is `412 stale` with `{ current }`, and a held ref without the matching fence is `409 fenced`. In
DynamoDB, rule 1 is the `parents[0]` check before the write, and rule 2 is the `is-ancestor` walk (§9.4) before
the write. Both then write under the condition `version = :expect`, so a concurrent move between check and write
fails the condition instead of landing.

**There is no ref-log item.** Every move extends the history reachable from the ref, and `history` walks first
parents from the head (with `merges: true` to descend). Who and why travel in each commit's author and trailers. A
multi-step fast-forward (rule 2) adds the target's whole ancestry to the walk, as git's does. Only a ref's create
and delete are outside history: `createdAt` and `createdBy` sit on the item, and a delete is final.

**The repo log is history; there is no second event store** (fs-architect, 2026-11-14, for wf-repos' R1/R2).
`RepoDO`'s `ref_log` and `events` tables go with `RepoDO`, and nothing replaces them.

- **`GET /v1/repos/:id/log` is deleted.** `history` (§1) is the one route:
  - it walks first parents from the ref's head through 9.4's commit reads;
  - each entry is `{ version, parents, author, message, trailers, time }`;
  - the cursor is a commit id;
  - `ref` is required, so there is no lineage-wide log.
- **Who and why** come from the commit: `author`, the message, and the `Camel-*` trailers. The operation is the
  `Camel-Checkpoint` / `Camel-Op` trailer (`api`, `turn`, `job`, `merge`, `restore`), written by whoever makes the
  commit.
- **A console's "recent activity across branches"** is `GET …/refs` ordered by `updatedAt`, plus each ref's
  `history`. That is a read, not a feed.
- **Live changes** are the notify webhook (§9.11) into the watcher's outbox, not a pollable events table.
- **Not in the log, on purpose:**
  - Ref creates and deletes. A ref's creation is its item's `createdAt`/`createdBy`. A delete is final, and the
    deleted ref's commits stay readable by id from any ref that reaches them.
  - Lease and fence events (take, renew, release, takeover). These are operational facts, not history. They go to
    the tier's structured logs and metrics (camel-fs.md §1.12), keyed by lineage, ref, holder and epoch.

  If a product need for either appears (an audit trail of branch deletions, say), it becomes a `deliveries`-style
  item written in the same transaction as the delete, decided then; it is not built speculatively now.

**Leases and fences** sit on the ref item. A host's CAS is conditioned on
`version = :expect AND holder = :holder AND leaseEpoch = :epoch`, where holder and epoch come **only from the
verified token's `fence` claim**, never from a request body (§9.10). An API writer's CAS is conditioned on
`attribute_not_exists(holder)`.
A lease is live while `now < leaseDeadline`: it expires **at** its deadline. So a lease is taken with
`attribute_not_exists(holder) OR leaseDeadline <= :now`, and the new epoch is the old one + 1.
`:now` is the tier node's clock (AWS Time Sync, sub-millisecond skew between nodes) against a 10-minute lease
renewed every TTL/3, so skew is noise. A node whose clock disagrees with DynamoDB's own write time by more than a
second refuses lease operations loudly. The rules of camel-fs.md §1.2 hold unchanged: one writer per branch,
fenced; a held branch refuses API writes and merges into it; a reboot changes the boot epoch.

**Per-path expect** (`PUT …/files/:path?expect=<blob>`) is checked by the tier against the tree at the head it read.
Trees are immutable and addressed by id, and the conditional write pins that head, so the check holds. Two tier
nodes racing on one ref are serialized by the condition. The loser re-reads the head and, when every per-path
expect still holds on the new head, rebuilds its commit on it and tries once more (one extra round trip under
contention). A whole-ref `expect` that lost, or a second loss, is `412 stale` with the current version.

**Quota** is checked inside the tier's write and is money-adjacent (the lead reviews it line by line).
- The request carries `quota: { limitBytes, otherBytes }`, which the runtime computes from the tenant's other
  repos.
- The tier refuses `507 storage_limit` with `{ limit }`, with **no** ref change, when
  `otherBytes + repoBytesAfter > limitBytes`.
- Every write's result carries `bytes` (the lineage's usage, `markedBytes + writtenSince`, below) and `files` (the
  recursive file count of the moved-to tree).

**How repo bytes are kept: decided (Miguel, 2026-11-13 ~17:40), the mark count plus bytes written since.**
`repoBytes` is the exact distinct-blob bytes reachable from all of the repo's heads, as measured by the last GC mark
pass (camel-fs.md §1.9), plus the bytes written since that pass. It lives on the `lineages` item as
`markedBytes`, `markedAt` and `writtenSince`.

- **The mark pass** runs hourly. It also runs on demand when a write is refused, or when a repo crosses ~90 % of
  its limit. It walks every head and writes the exact deduplicated base.
  - The reset does not lose a concurrent write: the pass snapshots `S = writtenSince` when it starts, then commits
    `SET markedBytes = :m, markedAt = :now, writtenSince = writtenSince - :S` conditioned on
    `markedAt = :prev`.
- **`writtenSince` increments at blob upload** (`PUT …/blobs`, 9.1), and only when that upload created
  `<lineage>/o/<sha1>`.
  - It is not part of the ref-move transaction, so a write stays one conditional write on the ref.
  - A blob uploaded but never committed counts until the next mark, a conservative over-count.
- **Between passes the count reads high, not low.** Deletes and moves away from a blob free quota only at the
  next pass, so a repo near its limit may briefly be refused, and the next pass (or the on-demand recount the
  refusal triggers) corrects it.
- **The one bounded under-count:** a blob that was unreachable at the last mark but not yet swept, and is then
  referenced again, is not new: its upload creates nothing, so it adds nothing until the next mark. The error is
  bounded by one mark interval (hourly, or sooner through the 90 % or refusal recount).
- **Quota is therefore a soft limit.** Storage billing does not use it: it uses the exact mark (`usage.storage`,
  camel-fs-compute.md §4).
- **Owner:** proto-block, in C3. The `writtenSince` counter is on the `lineages` item, and the mark pass writes the
  base.

The alternative, an exact per-blob refcount maintained by every ref move, was rejected: it is a transaction across
the ref and its counters on every write. So was "distinct bytes ever written, never shrinking", because deleting
files must free quota.

**Notify** is a signed webhook from the tier to the runtime (§9.11), at least once, landing as an outbox row in the
receiving object, which the receiver's alarm then drains, as wf-durable's design already does for host results. A
move of a watched ref writes its delivery item in the same transaction as the move, so a crash between the two
cannot lose a notification. A host checkpoint's result already carries `{version, tree}` and the diff to the
`HostJob` that dispatched it, so the job's owner learns of the move without a webhook.

**Agents cache trees by tree id** in their own Durable Object's SQLite. The cache is not a TTL cache: an id never
changes meaning, and the cache is bounded by size, oldest tree first. After its own write the agent knows the new
tree id and the changed entries (the write's reply carries them), and after a job, `bash` or computer checkpoint the
result carries the tree and the diff. So `ls`, `stat`, `glob`, `read`'s blob lookup and the write precondition of
the agent's own version never leave the object. A foreign version is one ref `GET` plus one diff by tree pair,
O(changed).

**The single write path**, the same for a Worker's `PUT`, an agent's `edit`, a host's checkpoint and a merge:

1. write the new objects (blobs to S3; trees and the commit to DynamoDB, S3 until L74 lands), in one parallel
   wave: they are content-addressed and computable before any write, so nothing orders them but the CAS;
2. one conditional write on the ref item, `version = :expect` plus the lease state the writer holds, after the
   ref-move rules have been checked.

An API write does both in one call to the tier (§9.9's `write`). A host does step 1 in its checkpoint and step 2
with a `cas` to the tier over the VPC, using the fence-scoped token the runtime minted at dispatch (§9.7, §9.10),
and reports the outcome in its result. The runtime never relays a CAS.

Objects written for a CAS that loses are garbage. The collector (reachability from refs, generational, from S3
Inventory; camel-fs.md §1.9) reclaims them, and a `touch` on every reference-by-id keeps a concurrent writer safe.

**Cross-lineage operations without a global transaction.** Two operations touch more than one repo, and neither
needs atomicity across items:

- **Fork into a new repo** (`POST /v1/repos { from: { repo, version } }`): the source is a *version*, immutable, so
  the new repo's `main` is created at that version; nothing in the source changes. A source deleted a moment later
  leaves the version reachable from the new repo's ref: objects are unowned, and the mark walks every lineage's
  refs. A fork inherits its source's lineage (§9), so it is one ref item.
- **Cross-repo `commit … from: { repo, version, path }`** and **merge from another repo's version**: again a read of
  an immutable version plus one CAS on the target. The only cross-repo fact is that the referenced objects stay
  alive, which the `touch` on reference-by-id guarantees across the GC's mark.

Everything else (a mount of several repos, a workflow owning branches in several repos, an export) is a sequence of
single-ref operations. A failure between them leaves each ref consistent and unmoved, never half-moved. Nothing in
the model requires two refs to move together.

**Build order** (from the study; each step a PR stack onto `camelfs/files-model`):

1. `camelfsd --role api` behind an ALB (HTTP/2 off, after the 10-24 stalls) with runtime-signed tokens (§9.10), `CAMELFS`
   switched to HTTPS, the tunnel and the shared bearer deleted (L30).
2. Miguel creates the DynamoDB tables (`objects`, `refs`, `lineages`, `deliveries`; on demand, PITR) and the IAM
   roles (api, host). Tokens reuse the runtime's `RuntimeSigner` keys; the tier gets their JWKS as a file (§9.10).
3. The Go `refs` package with the ref-move rules checked before a `version = :expect` condition, leases, fences, watchers and
   the quota check (its bookkeeping waits on Miguel). Its contract
   tests are ported from `RepoDO`'s tests and the strict fake.
4. The runtime's `RepoClient` swap (stub → HTTP), with `write.ts`'s loop deleted; `HostJob`'s lease and renew over
   HTTPS; the agent-side tree cache.
5. Hosts do the CAS in-VPC, notify arrives as webhooks into outbox rows, the public `/v1/repos` moves onto the tier,
   and `RepoDO` is deleted.
6. Node on the same API.

**Measured first:** the Worker → us-west-2 round trip (far and `wnam`) and DynamoDB's conditional-write p50/p99 from
the tier's seat. Step 1 does not wait for them.

## 7. What gets deleted, and the phases

**Deleted** (line counts from `main` at `17214fef`, 2026-11-13, from the Volumes inventory):

| area | files | lines |
|---|---|---:|
| Workers volume model | `volume.ts` (the DO, its twelve tables, the R2 `files/<tenant>/<volume>/<uuid>/<sha>` layout, snapshots, pins, forwarded pins, read-set claims, `gc_candidates`, the daily alarm, `camelfs_trees`), `volume-commit.ts`, `volume-policy.ts`, `file-upload.ts` | 1,061 + 125 + 58 + 84 |
| Workers routes, mounts, tools | `files.ts` (the twelve `/v1/volumes/*` routes, `handleAgentFilesRoute`, the Pi tools; ~400 lines of tool shape are rewritten over repos), `file-mounts.ts`, `file-links.ts`, `file-output.ts`, `file-versions.ts`, `tool-files.ts`, `tool-output-files.ts`, `fs-tools.ts`, `history-pins.ts`, `agent-workspace.ts` (the R2 fork-claim objects), the volume calls in `dreaming.ts` | 1,160 + 214 + 80 + 67 + 27 + 147 + 56 + 72 + 21 + 88 + ~70 |
| Quotas | `storage-quota.ts`, `tenant-storage.ts`, `storage-usage.ts` (the limit stays, counted on the `lineages` item) | 29 + 116 + 177 |
| Workflows | `workflow-volumes.ts`, `workflow-forks.ts`, the fork-ownership half of `workflow-results.ts`, the `keep()` volume writes and `pushSpec` in `workflow-jobs.ts`, the `childVolume`/adopt paths in `workflow-object.ts` | 115 + 62 + ~100 + ~60 + ~40 |
| Jobs | `jobs/camel-sync.ts`, `jobs/host-sync-store.ts`, `jobs/camelfs.ts` (the import bridge), `JobSpec.volume`, `WireJob.files`/`sync`, `HostJob.files/fetch` and the `/v1/internal/job-hosts/sync/*` route, `pullFiles` and the guest `files` op past inline sizes | 150 + 37 + 82 + ~200 |
| Node backend | `src/volumes.ts`, `src/volume-tools.ts`, `src/volume-env.ts`, `src/tool-files.ts`, `src/file-arguments.ts`, `src/core/file-arguments.ts`, `src/files.ts`, `src/storage-gc.ts`, `src/storage-usage.ts`, `src/storage-integrity.ts`, `src/gc-verify.ts`, `src/pin-backfill.ts`, `src/computers/transfers.ts`, `scripts/{backfill-pins,check-storage,reconcile-storage,verify-gc}.ts` | 1,192 + 406 + 150 + 314 + 106 + 103 + 278 + 115 + 175 + 85 + 94 + 86 + ~300 |
| Daemon (proto-block's count) | `internal/refs/refs.go` and the `refs` table, the `job/<id>` ref creation in the tree-form mount, `POST /v0/forks`, the renew goroutine (~250 lines, one table); the import bridge `api/objects.go`, `client/trees.go` and the request handling of `objects.go` (~580 lines). The tree builder (~150 lines: trie → git-exact tree bytes, subtree reuse) and blob upload stay; so do `mounts`, `tree_roots`, `lineage_blobs`, `uploaded` and unit 8's `chunk_locations` as host-local cache | ~830 |
| Other Workers callers | `apply.ts` and `shared/apply.ts`'s keyed-volume creation, `computers/objects.ts:334` seeding and `computers/policy.ts`' volume text, `media/images.ts:285–344` and `media-api.ts`'s `volumeId` fields, `model.ts`'s R2-key decoding for image inputs, `channels.ts`' volume file routes, `prompt-attachments.ts`' pin calls, `hosted-mcp-tools.ts`' mounts schema, `account-export.ts`/`account-deletion.ts`/`account-lifecycle.ts`'s volume walks, `admin/admin-usage.ts`' volume counts | ~600, rewritten over repos |
| Clients and console | `clients/projects.ts`, `clients/python/camelai_run/projects.py` (dropped outright); `VolumeHandle`, `AgentFiles`' volume paths, `FileUrlClaims` in `clients/server.ts`, Python `Volume` (rewritten as `RepoHandle`); `console/web/pages/volumes.tsx`, `components/files.tsx` (rewritten over repos); `evals/workflows/lib/runtime.ts`, `choice.ts`, `run.ts` (over `RepoHandle`) | 203 + 176 + ~500 + 145 + 233 + ~150 |
| Schema and docs | migrations to retire: `volumes`, `volume_snapshots`, `volume_watchers` (001), `storage_usage` (012), `storage_gc`/`chunk_touches`/`chunk_pins` (026), 058, 060, `agent_dreaming.volume` (129); OpenAPI's twelve volume paths and eighteen file/volume/snapshot/mount schemas (~1,000 lines); `docs/guides/files.md` "Volumes", `projects.md`, and the volume sections of `limits.md`, `errors.md`, `persistence.md`, `privacy.md`, `billing.md`, `apply.md`, `workflows.md`, `multi-agent.md`, `computers.md`, `tools.md`, `concepts.md` | rewritten |
| Tests | `tests/volumes.test.ts` 778, `volume-commit` 140, `volume-env` 172, `storage-gc` 217, `prop-storage-gc` 218, `storage-limits` 178, `storage-integrity` 57, `storage` 179, `gc-verify` 56, `projects` 223, `files` 351, `tool-files` 282, `file-arguments` 295, `file-link-tools` 144, `purge` 214; Workers `volume-commit.integration` 278, `files.integration` 258, `file-*` 253, `tenant-storage` 93, `host-sync-store` 30, `camelfs-import` 127, `workflow-jobs` 407, `workflow-results` 122, `computer-fork` 190; the volume sections of `tests/python_sdk.py`; `tests/sim/corpus/storage.json` | ~5,300, rewritten over repos |

About **4,900 lines** of volume code go on Workers, **3,400** on Node, **830** in the daemon and **1,250** in clients
and console, plus the schema, docs and ~5,300 lines of tests that follow them. What replaces them is the tier's Go `refs` package
(~500), the files API over it (~600), the tools rewrite (~400) and the SDK, console and OpenAPI rewrites, on top of
`camelfsd` and the storage plane, which already exist.

**Phases** (each a PR stack onto the integration branch `camelfs/files-model`, each usable alone and stated by its
bar, not a date: Miguel wants fast iteration, and the three lanes of §9 build in parallel; v0's ledger continues
throughout):

1. **The service and the API** (option C, build steps 1–5 of §6): `camelfsd --role api` with the `refs` package
   on DynamoDB (refs, leases, fences, quota, watchers), tokens and the notify webhook; `/v1/repos/*` including files, `files:batch`,
   `commit`, `history`, `diff`, `restore`, `branches`, `merge`; tokens; the Pi file tools over repos for agents
   without a VM (every write a commit); `checkpoint(message)`, `restore`, `history`, `diff` as tools; the edge cache
   on `blobs/:sha`. New agents get repos; nothing else changes yet.
   Bar, per leg (restated under C, ledger L89): the tier's in-region write (objects in one wave + the conditional
   write) ≤ 50 ms p50 once trees are in DynamoDB (L74), the study's floor of one S3 PUT ≈ 40 + one conditional
   write ≈ 5; a Worker file write end to end = that + the measured Worker → us-west-2 round trip (estimated 85 ms
   from an arbitrary colo, 25 placed `wnam`); `files:batch` of 20 files ≤ 150 ms; fork ≤ 50 ms; merge of 3 disjoint
   edits ≤ 200 ms; `history`/`diff` ≤ 100 ms at 50k files.
2. **Hosts, jobs and workflows on refs**: hosts do their CAS in-VPC against the tier with a fence-scoped token
   (§9.7); `job({ at: { repo, ref? | version? }, commit })` mounts the tree with no import; the `job/<id>` branch, merge and
   fast-forward effects; result cache on the tree; `keep()` as one commit; computers mount the agent's ref with the
   lease (per camel-fs.md phase 2). The import bridge and `camel-sync` are deleted.
   Bar: job placement → first command ≤ 300 ms warm with no import leg (ledger L25, L43, L68 close); result leg
   (L70) ≤ 300 ms; a commit job's branch merges or fast-forwards in one effect.
3. **Everything Volumes did**: the published-ref pattern as an SDK example (projects and `publishTool`
   deleted); uploads and attachments as commits with the history ref; dreaming on a repo; signed links on blobs and
   versions; `notify` as signed webhooks into outbox rows (§9.11); account export (tar + bundle) and deletion by refs; quota and billing
   from the `lineages` counters; `grep` on the index for every agent; the console's repos page; SDKs and OpenAPI;
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
such above: the state split (§6, option C) and dropping projects and `publishTool` (§5).

1. **The word: `repo`** (default). It names the API path (`/v1/repos`), the SDK handle (`RepoHandle`) and every doc.
   Developers already know that a repo has branches, history, forks, diffs and restores; "workspace" collides with the
   agent's own mount. Override cost: a rename.
2. **Every API write is a commit** (default). Per write, under the decided split: one blob PUT to S3 ($5 per
   million, $0.000005), about four tree writes and one commit write to DynamoDB (1–3 KB each, so ≈ 10 write units at
   $1.25 per million, $0.0000125), one conditional write on the ref item (one write unit, $0.00000125), one `writtenSince`
   increment per new blob for quota (one more unit, $0.00000125), and the tier (≈ $0.000001 per write): **≈ $0.000021
   per write** under option C (§6), so the 144 M writes and 14.6 M checkpoints a month of camel-fs.md's 1,000-agent
   baseline cost **≈ $3,300/month**, less with tree segments (one item per write's trees); AWS's late-2024
   on-demand price cut may halve the DynamoDB lines. Tonight's
   S3-only variant is ≈ $0.000033 per write (six PUTs plus the CAS), ≈ $4,800/month. The alternative, coalescing a
   VM-less agent's writes within a turn into one commit at turn end, would cut the write line ~5× (to the ~20
   checkpoints an hour the VM path pays) and lose per-write history and blame. Default: every write, with `commit`
   for multi-file tools. Override cost: a turn-end coalescer in the files API; §3 and §2 change, §9 does not.
3. **Published versions are refs** (default): `published` (or `published/<n>`) and `release/<label>` replace pinned
   snapshots and labels; a repo with thousands of publishes has thousands of refs, which the lineage's partition in
   `refs` holds without strain and `refs?prefix=published/` lists. Override: a single `published` ref whose tree is a
   manifest of versions.
4. **The history ref keeps** (default): every version an agent's transcript shows stays reachable for the agent's
   life, today's rule ("a file an agent was sent or shown stays until the agent is deleted"), so `rm` or `restore` on
   `main` never breaks a message that showed a file. Override: let `main` win and have the transcript's link fail.

Not a question any more: the edge cache's trust boundary is settled by §3 and §9.1 (authorization by `(version,
path)` before any lookup by hash). camel-bots' move off project snapshots is migration, later (§5).

## 9. The storage-plane contract: the camel-fs service

This section is the build contract for the lanes working in parallel: the service (`proto-block`: the tier and its
`refs` package), the runtime's files API and tools (`wf-repos`), and jobs and hosts (`wf-delegation`). Under option C
(§6) it is the exact HTTP API of `camelfsd --role api`, a stateless Go tier behind an ALB in us-west-2. The
callers are the runtime (Workers and Node, over HTTPS), the hosts (`camelfsd --role host` and `jobhost`, in-VPC) and,
from build step 5, customers on the public `/v1/repos`. Until step 1 lands, the same routes are served by the m8id's
daemon behind the `CAMELFS` tunnel with the shared bearer (L30). Everything else about a host's daemon (mount, fork,
release, the cache, the lazy origin, hydration) is unchanged and stays on the host's Unix socket.

**Division of ownership.** The tier owns refs, leases, fences and watchers, checks quota, and performs every CAS
(§9.9). It holds no state of its own: refs are DynamoDB items, objects are DynamoDB items and S3 objects, and any
node answers any request. It also stores and serves the immutable, content-addressed objects (blobs, trees,
commits, chunks, roots, shards) and computes over them (commit, diff, merge, grep, read). Hosts hold no refs: a host
performs its own CAS through the tier with a fence-scoped token. The runtime is the authorizer, and it holds no
ref either. It signs scoped tokens (§9.10), keeps each tenant's repo list, and caches trees by id in each agent's
object. The tier enforces each token's scope, lineage scoping and the (tree, path) rule below, and trusts nothing it
is told about hashes.

**Storage.** Trees and commits are written durably before any call returns: to S3 tonight (`t/<sha1>`, `k/<sha1>`
beside blobs and chunks), and to DynamoDB `objects` when the table exists (L74), a swap inside the tier that is
invisible to this contract. A host's local tables (`mounts`, `tree_roots`, `lineage_blobs`, `uploaded`,
`chunk_locations`) are cache only.

**Conventions.** JSON over HTTPS; ids are hex (`blob`, `tree`, `commit`: git SHA-1; `root`, chunk: sha256).
`Authorization: Bearer <token>`, a runtime-signed scoped token (§9.10), checked before any storage call.
`Idempotency-Key` on every write: the tier stores `key → response` and replays it, so a retry returns the first
answer, and with `time` always given, a retry the tier has forgotten re-executes to the same ids (see
**Idempotency** below). Errors on these `/v1` routes are `{ "error": { "code", "message", "details"? } }` with the
codes in 9.8. The host socket's `/v0` routes keep their current `{ error, detail }` shape because `jobhost` parses
it. Sizes are in bytes. Paths are lineage-relative, normalized, with no leading slash. "The daemon" below means `camelfsd` in
whichever role serves the call: the tier for every `/v1` route, a host's daemon for 9.7.

**Lineage and reachability.** Every route is scoped by `lineage` in the path. A lineage is a string the runtime assigns
at repo creation, `<tenant>:<root repo id>`, and registers with `PUT /v1/lineages/{lineage}` (9.9); and **a fork into a new repo inherits its source's lineage** (wf-repos),
so forks share one object set and a fork is O(1) in objects as well as in refs; a repo made from scratch starts a new
lineage. The daemon records every object it writes for a lineage, trees **including subtrees** (listings hand out
subtree ids) and blobs alike, and refuses any reference the lineage has not written or imported, with
`404`/`400`, never "exists but not yours". **Membership must survive a wiped data directory** (a fresh host must be
able to answer "is this id reachable from this lineage" without the previous host's SQLite), so it lives in the
object store, and it lives there as the key: **object keys carry the lineage**, `<lineage>/t/<sha1>`,
`<lineage>/k/<sha1>`, `<lineage>/b/<sha1>`, chunks likewise, and in DynamoDB the lineage is part of the partition
key. Existence of the key is the membership; there is no marker object and no second write, so a commit stays one
`PUT` per new object and the §8 price stays at ≈ $0.0000207 per write. `lineage_objects` and `lineage_blobs` in
SQLite are a derived cache, refilled by a `HEAD` of the key on a miss; a blob's size and sha256 travel as S3 object
metadata so that `HEAD` is enough; chunks and roots are prefixed the same way, and the NBD export name becomes
`<lineage>/<root>`. Objects are lineage-scoped already (a fork into a new repo inherits
the lineage; a cross-lineage reference copies), so prefixing loses nothing within a lineage, makes quota a prefix sum,
and turns the cross-lineage copy into a server-side `CopyObject`. The trade-off, recorded in camel-fs.md §1.1: blobs
no longer dedupe across lineages, a file common to unrelated repos is stored once per lineage, at storage price; the
host cache stays keyed by content hash, so a host serving two lineages holds a shared blob once. Two details for the
daemon: the per-host `uploaded` inventory keys by the full prefixed key (it stores full keys already), and a
`CopyObject` fork into a new lineage takes the source's object list from its trees. A cross-lineage reference
(`commit … from: { repo, version, path }` across tenants' repos, or any other) is, tonight, a read followed by a
`PUT` of the bytes into the target lineage; an `adopt` call that grants reach without copying is a later,
low-priority addition.

**Idempotency is a property of the request, not of the replay table.** Every write in this contract is
content-addressed and deterministic given its body: a blob `PUT` yields the hash of its bytes, and a commit's ids are
a pure function of `parents`, `baseTree`, `changes`, `author`, `message`, trailers and `time`. **The runtime always
passes `time`** (it never lets the daemon pick a clock), so a retried write that the daemon has no memory of
re-executes to the identical ids and is harmless. The `Idempotency-Key → response` table is a host-local SQLite
optimization that saves the re-execution and is lost with the data directory; its loss changes latency, never
outcome (L80).

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
(so the caller needs no follow-up `GET`). Rules: `parents` is a list (`[]` for a first commit;
two for a merge); `baseTree` defaults to `parents[0]`'s tree (the empty tree when there are none), and a **merge
commit** is `parents: [ours, theirs]`, `baseTree` = 9.5's merged tree, `changes: []`; **`changes: []` is allowed**
(a `checkpoint(message)` on an unheld ref, or a `restore`, whose `baseTree` is the old version's tree); every `blob`
named must already be in the lineage (from 9.1 or an earlier tree of this lineage), else `400 unknown_blob`.
**Validation is strict on both sides of the wire** (L86, after unit 9 shipped `parent` singular against this
section's `parents[]` and the runtime's lenient fake let every pilot write `400`): `parents` is required, an array,
empty only for a root commit, and its absence is `400 invalid_request`, never a default; unknown fields in the
request are rejected with `400 invalid_request` naming the field; the reply always carries `parents` and `time`
exactly as committed; and the runtime's fake of this contract rejects what the daemon rejects, so a test that
passes against the fake passes against the daemon. The real-daemon contract test covers every call in this
section. A
`mode`-only change keeps the blob; a `delete` of a missing path is a no-op; the new trees (only those on changed
paths), the commit (git's bytes, `committer camelfs`, the trailers in the message) are written to S3 **before** the
response. `time` (unix seconds) is chosen by the runtime and is part of the commit, so the commit id is a pure
function of the request and a retry with the same body reproduces it; a retry with the same `Idempotency-Key` is
replayed regardless. The tree id is deterministic either way. Caps: 10,000 changes per call (`413`). This route moves
no ref: a caller that wrote its own commit (a host's checkpoint does the equivalent) moves the ref with 9.9's `cas`, and
the API's one-call `write`, `merge` and `restore` of 9.9 do the commit and the CAS together.

### 9.4 Trees, commits, diff

`GET /v1/lineages/{lineage}/trees/{tree}?path=<dir>&recursive=0|1&after=<path>&limit=10000`
→ `{ "entries": [ { "path": "src/a.ts", "mode": "100644", "blob": "<sha1>", "size": 1234 }, … ], "next"?: "<path>" }`
(directories as `{ "path", "mode": "040000", "tree": "<sha1>" }` when not recursive).

`GET /v1/lineages/{lineage}/commits/{commit}` → `{ "tree", "parents": [...], "author", "message", "trailers": {...},
"time" }`.

`GET /v1/lineages/{lineage}/diff?from=<tree>&to=<tree>&path=<prefix>` →
`{ "changes": [ { "path", "status": "added" | "modified" | "deleted" | "mode", "oldBlob"?, "newBlob"?, "oldMode"?,
"newMode"?, "oldSize"?, "newSize"? } ] }`, O(changed), descending only into subtrees whose ids differ; each size is
absent on the side with no blob and comes from the tree entries the diff already loaded, so the agent's tree cache is updated
from the diff instead of re-listing every changed directory.

**Single-entry lookup and history questions** (unit 12, #961, from wf-repos' ranked needs; before them it stat'ed a
file at a non-head version by listing its directory recursively and authorized a pre-fork attachment by walking
commits one at a time):

`GET /v1/lineages/{lineage}/trees/{tree}/entry?path=<path>` → `{ "path", "mode", "blob", "size" }` for a file or
symlink, `{ "path", "mode": "040000", "tree" }` for a directory, `404 not_in_tree` otherwise; an O(depth) descent,
no listing.

`GET /v1/lineages/{lineage}/commits/{a}/is-ancestor?of=<b>` → `{ "ancestor": true | false }`: true when `a == b` or
`a` is reachable from `b` through parents; both must be commits of the lineage, else `404 not_found` naming which.

`GET /v1/lineages/{lineage}/merge-base?a=<commit>&b=<commit>` → `{ "base": "<commit>" | null, "tree": "<tree>" |
null }`: git's best common ancestor; several candidates → the latest `time`, then the greatest id; `null` when the histories are
disjoint.

Both walks are bounded at 50,000 distinct commits visited (for `merge-base`, counted across both sides together) and
answer `413 too_deep` past that, so a pathological history
cannot hold a request open; the caller treats `too_deep` as "not provable", never as "not an ancestor".

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

### 9.7 Host-side calls

Over the host's Unix socket (unchanged transport):

- `mount { jobId, lineage, tree, parent, fence: { holder, epoch } | null, token?, ... }` → `{ image, warm, mountMs }`. The
  fence and its token are what the runtime handed the host at dispatch; the daemon stores them and does not check
  them, because the tier's CAS does. `null` means a read-only `root`-form mount, which refuses checkpoints with
  `no_fence`. A fenced mount must carry `parent`, the version it mounts, which becomes the checkpoint commit's
  `parents[0]` (`400 invalid_request "missing field parent"` otherwise). The mount creates no ref and takes no lease. What stays: the tree → root lookup (`tree_roots`), the
  nearest-ancestor base, the blank image and the guest apply.
- `checkpoint { mount, message, trailers, time }` → `{ tree, root, commit, timings: { walkMs, streamMs, freezeMs,
  reflinkMs, fiemapMs, hashMs, uploadMs, imageMs, wallMs } }`. The daemon runs the §1.3 contract of camel-fs.md,
  writes blobs, trees, the commit (whose `parents[0]` is the mounted or last-checkpointed version) and the root,
  and returns. The CAS is the next call, below.

**Who does what** (wf-delegation, wf-durable):

- **Before dispatch**, `HostJob` creates the branch `job/<id>` at the version the job mounts (§9.9 `POST refs`,
  `owner: job:<id>`; for inline `files` that version is the scratch commit of §4) and takes the lease
  (`POST …/lease`). It mints a token scoped to that lineage and ref with the fence (§9.10), and puts
  `{ fence, token }` into `WireJob.camelfs`. `HostJob` renews the lease from its alarm every TTL/3 for the job's
  lifetime (10-minute cap). A renewal that finds the lease taken over fails the job's CAS later, never silently.
- **Jobs** checkpoint once, at the end. `jobhost` then calls the tier's `cas` in-VPC with the fence token
  (`expect` = the mounted version, `root` included), sends `checkpointed { tree }` to the guest, and puts the outcome
  in the result: `{ version, tree, diff, cas: "ok" }` or `{ cas: "<code>" }`. The tier is the host's authority for
  the move, and `HostJob` reads the outcome from the result rather than performing the CAS. A failed CAS becomes the
  job's `checkpointError` (`"cas: <code>"`), and the rest of the job's output stands.
- **Computers and `bash` VMs** (per-turn checkpoints in a long-lived VM) need the synchronous form: checkpoint →
  `cas` (in-VPC, ≈ 2 ms to the tier + ≈ 5 ms in DynamoDB) → `checkpointed { tree }` or `checkpointed { error }`,
  so the guest's index commits only after the ref moved. The runtime is not on this path.

The CAS carries the checkpoint's `root`, so a later job at that version mounts warm without the daemon rebuilding
the image; the ref item carries `root?` (§6).

### 9.8 Errors

| code | HTTP | when |
|---|---|---|
| `invalid_request` | 400 | malformed JSON, bad id, unnormalized path, unknown mode, unknown field, a ref name outside §1's alphabet |
| `unauthorized` | 401 | missing, malformed, expired or unverifiable token (the message names the reason) |
| `forbidden` | 403 | a valid token whose lineage, ref globs, ops or fence do not cover the request |
| `unknown_blob` / `unknown_tree` / `unknown_commit` | 400 | an id the lineage cannot reach is named in a write |
| `not_in_tree` | 404 | a read whose (tree, path) does not resolve to the requested blob, or a tree this lineage does not have |
| `not_found` | 404 | a commit named in a history question (`is-ancestor`, `merge-base`) that this lineage does not have; the body names which |
| `ref_not_found` | 404 | a ref route naming a ref the lineage does not have |
| `ref_exists` | 409 | `POST refs` on a name that exists |
| `stale` | 412 | the ref is not at `expect`, or a per-path `expectBlob` no longer holds; the body carries `current` (and `blob` for a path) |
| `bad_parent` | 409 | a new commit on an existing ref whose `parents[0]` is not current, or whose `parents` is not 1 (2 for a merge) long; the body carries `{ parents, current }` |
| `not_fast_forward` | 409 | a move to a recorded commit that does not reach current (ref-move rule 2), or `{ reason: "too_deep" }` past 50,000 visited (fails closed) |
| `held` | 409 | an API write, merge, restore or delete on a ref a VM holds, or a lease on a held ref whose deadline has not passed |
| `fenced` | 409 | a write to a held ref without a token whose `fence` claim matches the lease, or a `cas`, renew or release whose claimed holder or epoch is not the current lease |
| `storage_limit` | 507 | `otherBytes + repoBytesAfter > limitBytes`; the body carries `{ limit }`, and nothing is moved |
| `blob_mismatch` | 400 | `X-Camel-Sha256` did not match the bytes received |
| `too_large` | 413 | a blob over the single-PUT cap, a batch over 256 paths or 64 MiB, a commit over 10,000 changes, a `write` body over 8 MiB |
| `too_deep` | 413 | a history walk (`is-ancestor`, `merge-base`) past 50,000 commits visited; not provable, not a negative answer |
| `conflict` | 409 | a merge with conflicts (body lists them) |
| `no_fence` | 409 | a checkpoint on a mount without a fence |
| `unavailable` | 503 | S3 or DynamoDB unreachable, or throttled past the tier's retries; safe to retry with the same `Idempotency-Key` |

**These snake_case codes are canonical**, like every existing daemon code (`unknown_commit`, `too_deep`). The
runtime's `/v1/repos` **adopts** them (the lead, 2026-11-13): wf-repos renames the public repo codes to snake_case
after #954, so `RepoDO`'s kebab-case `bad-parent`, `not-fast-forward` and `storage-limit` go away.

Every error is loud and specific; nothing degrades to empty data. The tier logs lineage, ref names, ids, sizes and
token `sub`/`lin`/`acc`/`kid`, never file contents or tokens.

### 9.9 Refs

Every route below is one or two DynamoDB operations on the lineage's partition. Reads of a ref are strongly
consistent. Each mutating route takes `Idempotency-Key`; a replayed key returns the first answer, and an
unremembered retry of a move that already happened lands on ref-move rule 3 (same version, a no-op) when it names
the moved-to commit, or answers `412 stale` with `current` equal to the retry's commit, which the caller reads as
success.

**Lineages.** `PUT /v1/lineages/{lineage}` `{ "tenant", "kind": "workspace" | "image", "defaultBranch": "main" }` → `201`, or `200` when it already exists with the same tenant (anything else `409`).
The runtime calls it at repo creation, before the first commit. `GET` returns the item.

**Read and list.** `GET /v1/lineages/{lineage}/refs/{name}` → `{ "name", "version", "tree", "root"?, "owner",
"expiresAt"?, "holder"?, "leaseEpoch"?, "leaseDeadline"?, "createdAt", "createdBy", "updatedAt" }`.
`GET /v1/lineages/{lineage}/refs?prefix=<p>&after=<name>&limit=1000` → `{ "refs": [ … ], "next"? }`, a `Query` on
the partition (`refs?prefix=published/` lists a repo's publishes).

**Create.** `POST /v1/lineages/{lineage}/refs` `{ "name", "version", "owner", "expiresAt"? }` → `201` with the
item. Condition: `attribute_not_exists(name)`, or an expired unheld ref (`expiresAt <= :now`, no live lease), else
`409 ref_exists`. `version` must be a commit of the lineage
(`400 unknown_commit`). A branch copies nothing, whatever the tree's size, and may be created at any commit (rule 4). The owner prefix set and the name
alphabet of §1 are enforced here.

**Delete.** `DELETE /v1/lineages/{lineage}/refs/{name}?expect=<version>` → `204`. `expect` is optional: with it the
condition includes `version = :expect` (`412 stale`); without it, only that no lease is live (`409 held`). Final:
the ref's history stays reachable only from other refs.

**Expiry and epochs, everywhere in this section:**
- An unheld ref whose `expiresAt <= now` reads as **absent** on every route (`404 ref_not_found`, missing from
  listings) and may be re-created.
- `leaseEpoch` **never decreases** for a ref name, across delete and re-create, so a fence from a ref's earlier life
  can never match a later one. C2 carries the epoch across the delete.

**CAS (hosts, and any caller that wrote its own commit or moves to a recorded one).**
`POST /v1/lineages/{lineage}/refs/{name}/cas` `{ "commit", "expect", "root"?, "quota"? }` →
`200 { "version", "tree", "parents", "diff": [ …9.4's change shape… ], "bytes", "files" }`.
- `expect` is required: `cas` never creates a ref (`400 invalid_request`; creation is `POST refs`).
- The commit must be the lineage's (`400 unknown_commit`).
- `expect` must be current (`412 stale`). `commit == expect` is a no-op (rule 3).
- A commit made for this move must pass rule 1 (`409 bad_parent`); any other recorded commit must pass rule 2
  (`409 not_fast_forward`).
- The ref is then written under `version = :expect`, plus `holder` and `leaseEpoch` equal to the token's `fence`
  claim for a fenced token, else `attribute_not_exists(holder)` (`409 fenced` either way).
- The reply's `diff` (from `expect`'s tree to the commit's) is what the host puts in its result and what the agent
  folds into its tree cache.

The refs `PUT` of §1 is this route.

**Write (the API's one-call write).** `POST /v1/lineages/{lineage}/refs/{name}/write`
```json
{ "expect"?: "<version>", "quota"?: { "limitBytes", "otherBytes" },
  "changes": [ { "path": "src/a.ts", "text"?: "…", "base64"?: "…", "blob"?: "<sha1>", "mode"?: "100644",
                 "expectBlob"?: "<sha1>" | "none" },
               { "path": "old.txt", "delete": true, "expectBlob"?: "<sha1>" } ],
  "author": "agent:ag_123", "message": "edit src/a.ts", "time": 1763046000, "trailers": { … } }
```
→ `201 { "version", "tree", "parents", "time", "changed": [ { "path", "status", "oldBlob"?, "newBlob"?, "oldSize"?,
"newSize"?, "mode" } ], "bytes", "files" }`. In one call the tier reads the head; checks `expect` (whole ref) and every
`expectBlob` (per path, `none` = must not exist) against the head's tree (`412 stale`); writes inline bytes as blobs
(9.1), the changed trees and the commit (`parents: [head]`) in one wave; and moves the ref with the condition
`version = :head AND attribute_not_exists(holder)`, and refusing `507 storage_limit`
first when `quota` is given and the write would exceed it. A lost condition retries once on the new head when no whole-ref `expect` was given and every
`expectBlob` still holds (§6). Inline bytes are capped at 8 MiB per call; a larger file goes through 9.1 first and
is named by `blob`. `changes` may be empty (a `checkpoint(message)` on an unheld ref). This is the route the files
API's `PUT`/`DELETE …/files/:path` and `POST …/commit` map onto, and the agents' `write`/`edit` tools call it once
per tool call.

**Merge.** `POST /v1/lineages/{lineage}/refs/{name}/merge` `{ "theirs": "<version>", "mode": "merge" | "squash" |
"ff-only", "author", "message", "time", "trailers"? }` → `201 { "version", "tree", "ff": true | false, "merged",
"took" }` or `409 conflict` (9.5's body; nothing moved). When the head is an ancestor of `theirs` (rule 2's walk), `merge`
and `ff-only` move the ref to `theirs`, a fast-forward with zero new bytes. Otherwise `ff-only` is
`409 not_fast_forward`, and `merge` computes the merge base (9.4), merges the trees (9.5) and commits
`parents: [head, theirs]` (`squash`: `[head]`) under rule 1. Either way the
ref moves under the same condition as `write`.

**Restore.** `POST /v1/lineages/{lineage}/refs/{name}/restore` `{ "version", "author", "message", "time" }` →
`201 { "version", "tree" }`: a new commit whose tree is `version`'s tree and whose parent is the head. History is
never rewritten.

**Leases.** `POST /v1/lineages/{lineage}/refs/{name}/lease` `{ "holder": { "host", "boot", "mount" }, "ttlMs" }`
(`ttlMs` ≤ 600,000) → `200 { "epoch", "deadline", "version", "tree" }`. Condition:
`attribute_not_exists(holder) OR leaseDeadline <= :now` (a lease is live while `now < leaseDeadline`), else `409 held`;
the epoch is the previous epoch + 1.
`POST …/lease/renew` `{ "ttlMs" }` → `200 { "deadline" }`, with the condition `holder = :holder
AND leaseEpoch = :epoch AND leaseDeadline > :now`, where holder and epoch come from the token's `fence` claim
(`409 fenced`). `DELETE …/lease` → `204`, under the same condition. The lease's `POST` needs a runtime token (§9.10); the
runtime then mints the fence-scoped token from its answer. A host's pre-checkpoint check is a `GET` of the ref, comparing `holder` and
`leaseEpoch`.

**Watchers.** `PUT /v1/lineages/{lineage}/refs/{name}/watchers/{watcher}` → `204`, and
`DELETE …/watchers/{watcher}` → `204`. `watcher` is an owner-form id (`agent:<id>`, `workflow:<id>`). Delivery goes
to the runtime's one notify endpoint, configured on the tier (§9.11), never to a URL a caller names.

### 9.10 Tokens

**Decided (the lead, 2026-11-13): camel-fs tokens are one more family of camelRun's existing `RuntimeSigner`**
(`backends/workers/src/runtime-identity.ts`), not a second token system. That signer issues Ed25519 JWTs with a
`kid`; its keys live in Postgres `signing_keys` and are published as a JWKS (`/.well-known/jwks.json`); and its
families are separated by `typ` and `aud` (file URLs, for example, are `file+jwt` / `camelrun:file`). The runtime
mints, and the tier only verifies. proto-block's C1 spec is the build contract, summarized here.

```
header: { "alg": "EdDSA", "typ": "camelfs+jwt", "kid": "…" }
claims: { "iss": "<runtime URL>", "aud": "camelrun:camelfs", "sub": "agent:ag_123", "lin": "t_9:repo_4",
          "acc": "r" | "w", "refs": ["main", "published/*"], "fence"?: { "holder": "…", "epoch": 7 },
          "iat": 1763046000, "exp": 1763046900 }
```

**Verification on the tier:**
- The keys come from a static JWKS file (`--jwks-file`, or the `CAMELFS_JWKS` env), loaded at start and reloaded
  atomically on SIGHUP. A bad file keeps the old set and logs an error.
- There is no network fetch of a JWKS and no cache. Rotation is: add the new key to the file, then remove the old.
- **EdDSA only.**
  - Rejected: `none`, `HS*`, `RS*`, and any `jwk`, `jku`, `x5u` or `crit` header.
  - Also rejected: a signature over anything but the exact `header.payload` bytes, padded or non-url base64,
    duplicate JSON keys, and a token over 8 KiB.
- `typ`, `aud` and `iss` must match exactly. `exp` is required, and `exp − iat` is at most `--token-max-ttl`
  (default 15 minutes). `iat` may be at most 5 s in the future.
- `lin` must equal the path's `{lineage}` exactly.
- `acc` is `r` or `w`, and `w` implies `r`. Read routes (9.1 `GET`, 9.2, 9.4, 9.6, ref reads) need `r`. Writes
  (blobs, commits, merge, every mutating 9.9 route) need `w`.
- Mutating ref routes also require the ref name to match one of `refs`. The globs are segments of
  `[A-Za-z0-9._-]` and `*`, at most 64 of them.
- Unknown claims are ignored; malformed known claims are refused.
- Errors are `401 unauthorized` (missing, invalid or expired, with the specific reason) and `403 forbidden` (a
  valid token whose `lin`, `acc` or `refs` does not cover the request). The tier logs `sub`, `lin`, `acc` and
  `kid`, never the token.

**The fence lives only inside the signed token.**
- A token with `fence` writes exactly the one ref in its `refs`. Its `cas`, lease renew and release are conditioned
  on that holder and epoch. A fence in a request body is never trusted, and the routes take none.
- `HostJob` mints the host's token when it takes the lease, and mints a fresh one with each renewal (every TTL/3,
  inside the 15-minute cap). The new token is pushed to the host with the renewal, and the host uses the latest.
  The fence, not `exp`, is what stops a late host.

**Who gets which token:**
- An agent's tool calls: `acc: w` on its workspace's `main`, `r` elsewhere.
- A workflow child: `w` on `fork/<effect>`, `r` on `main`.
- A job's host: a fence token on `job/<id>`.
- A customer: one from the runtime's token endpoint against their API key.
- A laptop clone: `r` on one branch.

The lease route and the watcher routes are runtime-only. They take a token whose `sub` is in the runtime's service
namespace (`runtime:*`), a rule the refs PR (C2) enforces.

**Revocation** is key rotation, since every token is short-lived. There is no deny-list. Unauthenticated routes
are only the ALB's health check. The host role keeps its shared bearer on its socket and 8790 listener until L30
closes.

**Tier ↔ host calls use no token.** They are authenticated by mutual TLS (§9.12). The `camelfs-host+jwt` family
that #971 added here is replaced by it, so "the tier only verifies" holds for every token: the runtime mints
them all.

### 9.11 Notify webhook

When a watched ref moves, the tier writes a `deliveries` item (`{ id, lineage, ref, from, to, tree, by, at,
watchers }`) in the same `TransactWriteItems` as the move. The table's key is `shard` + `id`: `shard` is a fixed
small range (`hash(id) mod 16`), so the tier nodes find pending deliveries with one `Query` per shard instead of a
`Scan`; compute's `vm.*` events (camel-fs-compute.md §2) share the table. Usage events never use it: they are pulled
(§9.13). Any tier node then claims it (a conditional
`claimedUntil`), POSTs it to the runtime's notify endpoint, and deletes it on a `2xx`.

```
POST {runtime}/v1/internal/camelfs/notify
Camel-Signature: t=1763046000,v1=<hex hmac-sha256(notifyKey, t + "." + body)>
{ "id": "dlv_…", "lineage", "ref", "from": "<version>", "to": "<version>", "tree", "by": "agent:ag_123",
  "at": 1763046000, "watchers": ["agent:ag_7", "workflow:wf_2"] }
```

- The runtime rejects a signature older than 5 minutes.
- For each watcher it writes an outbox row keyed by `id` into the receiving object; the insert is idempotent, so
  a redelivery is a no-op. It answers `2xx` only after the rows commit.
- The receiver's alarm drains them, coalesced as today's `notify`.
- The tier retries with backoff (1 s doubling to 5 min) for 24 h, then deletes the item and logs
  `notify_dropped`, loud, never silent.
- `notifyKey` is separate from the token key, and both sides hold it.
- Nothing on this webhook carries money: usage is pulled (§9.13).
- Delivery is at least once and unordered across refs. A receiver orders by the chain: `from` is the version it
  should have, so a gap means it reads the ref.

### 9.12 Transport identity: mutual TLS

**Decided (Miguel, 2026-11-13 ~18:10): mTLS, "probably safer and simpler".** A connection's certificate proves
*which machine* is calling. The token of §9.10 still decides *what* a runtime caller may do, per lineage. Owners:
- **fs-infra:** the ALB trust stores, Authenticated Origin Pulls, the CAs.
- **proto-block:** the host side (K2).
- **wf-durable:** the tier side (K4c).

**1. Cloudflare → the public ALB (`fs.camelai.dev`): Authenticated Origin Pulls with a zone-specific certificate.**
Cloudflare's *default* origin-pull certificate is the same for every Cloudflare customer. An ALB that trusts it
proves only "this came through Cloudflare", and anyone can proxy their own zone to our address. So we use a
**zone-level AOP certificate of our own**, uploaded to the `camelai.dev` zone. (A per-hostname certificate on
`fs.camelai.dev` would be narrower still, and is the option if other hostnames in the zone ever share the origin.)
- The certificate is issued by a small dedicated AOP CA (below).
- The public ALB's HTTPS listener runs **mTLS in verify mode**, with a trust store holding only that CA. A
  handshake without our zone's certificate fails at the ALB, before any HTTP.
- The Cloudflare-ranges-only security group stays as a second lock.
- Rotating the AOP certificate: upload the new one to Cloudflare, add its CA to the trust store if it changed,
  then remove the old.

**2. Tier ↔ host, both directions: mutual TLS with a private CA.**
- **Host → tier.** Hosts call `fs-internal.camelai.dev` (the internal ALB). Its listener runs mTLS in verify
  mode against the private CA.
  - A host certificate carries the host id as a URI SAN, `spiffe://camelfs/host/<hostId>`. **That certificate is
    the host's identity.** It replaces the attested identity for every host → tier call.
  - The ALB strips any client-supplied `X-Amzn-Mtls-Clientcert-*` headers and sets its own from the verified leaf.
    The tier reads the host id from them, and only the ALBs' security groups reach the tasks.
  - A call from host A about host B's VM is refused: the host id in the path must equal the certificate's.
  - **A host's `cas` and lease calls** are accepted only when the lease holder's `host` equals the certificate's
    host id **and** its `boot` equals that host's current `bootEpoch` (`hosts` item), else `403 forbidden`. The
    holder string is `<host>:<bootEpoch>:<vm id>`, and the tier takes the ref lease just before it writes
    `booting` (camel-fs-compute.md §2). A rebooted host's old leases are refused on sight (L16).
- **Tier → host** (port 8792, `--listen-compute`).
  - The tier presents its own client certificate (URI SAN `spiffe://camelfs/tier`).
  - The host serves a certificate with its own id, which the tier checks against the host it meant to call
    (verification by SAN, not by IP hostname).
  - The host accepts only a peer whose certificate chains to the private CA and names the tier.
- **This replaces the `camelfs-host+jwt` family** of §9.10 (#971): one mechanism and no service signing key.
- **The per-call `{ host, vm }` scoping goes too.** The tier is the only caller the host accepts, and it is
  trusted with every VM on the host anyway. A token scoped to one VM would bound nothing a compromised tier could
  not mint for itself. The host still checks that a named VM is one of its own, as state, not as authorization.

**3. The CA: AWS Private CA in short-lived certificate mode, with the tier as the registration authority
(recommended).** Either option needs something that decides *which host id* a certificate may carry, because IAM
cannot constrain a certificate's subject. That something is the tier's enrollment call.
- **Enrollment.** A new host presents its STS attestation (`shared/job-host-attest.ts`: a signed
  `GetCallerIdentity`) once at boot. It does so on a separate internal listener without client certificates,
  which serves only `POST /v1/hosts/enroll`.
- **Issuance.** The tier checks the attestation's instance against the pool and issues a 24-hour certificate for
  that host id. Renewal every 8 h is the same call over the host's current mTLS certificate.

| | AWS Private CA, short-lived mode | self-run CA (key in Secrets Manager, Go `crypto/x509` in the tier) |
|---|---|---|
| CA key | in AWS's HSM, never exportable; a compromised tier can issue only while compromised and loses that when its IAM role is cut | a file the tier reads; a compromised tier can copy it, and every certificate it ever signs stays valid until the CA is replaced |
| cost | ≈ $50/month per CA plus ≈ $0.06 per certificate: tens of hosts × 3 renewals a day ≈ 1–3 k certificates ≈ $60–180/month, plus the tier's own | ≈ $0.40/month (one secret) |
| rotation | AWS rotates nothing for you either, but a new CA is an API call; the trust stores hold old + new during the overlap; leaf certificates expire within a day, so revocation is expiry plus removing the host from `hosts` | the same procedure, plus generating and protecting the key ourselves |
| code | `IssueCertificate` / `GetCertificate` from the tier | ≈ 150 lines of issuance, serials and CSR checks we own |

**Recommendation: AWS Private CA (short-lived mode).** The difference that matters is the key: with Private CA, a
tier compromise cannot outlive itself by stealing the CA. For ≈ $100–200 a month, that is the safer of the two and
not the more complex one. Certificate validity is capped at 7 days in this mode, so the **AOP certificate**, which
must live in Cloudflare for months, comes from a separate small offline CA. fs-infra keeps its key in Secrets
Manager, used only to sign the yearly AOP certificate, and trusted only by the public ALB.

**4. Runtime → tier stays on tokens.** Per-lineage authorization needs the token whatever the transport proves.
Should Workers also present a client certificate (the `mtls_certificates` binding)? **Not now.** AOP already
limits the public ALB to traffic through our zone, the token already identifies and scopes the caller, and a
Worker certificate would add a second credential that authorizes nothing new. Revisit if the tier ever serves a
route without a token, or if anything other than the runtime gets a proxied hostname in front of the same ALB.

### 9.13 Usage: pulled, never pushed

**Decided (Miguel, 2026-11-13 ~18:50).** camel-fs never pushes money data. It records usage durably next to the
state that produced it, and the runtime pulls it. Owners:
- **wf-durable** (K4b): the `usage` table and the deadline lease (camel-fs-compute.md §4).
- **wf-durable** (K4d): this route.
- **wf-durable** (K5): the runtime's poller.

**The table.** `usage`, key `shard` (S, `"0"`..`"15"`, a hash mod 16, as for `deliveries`) + `ulid` (S), DynamoDB TTL
on `expiresAt` at 35 days. TTL deletes 0–48 h late, so an event stays readable for 35–37 days.
- **Two ids per event.** The `ulid` is the read-ordering key. Each event also carries a deterministic `eventId`
  (`<vm>:<seq>` for a VM, `<lineage>:<markedAt>` for storage), which the runtime dedupes on. Gaps in a VM's `seq`
  are visible to the runtime and to tests.
- Each event is written in the **same** `TransactWriteItems` as the state change it accounts for. For a VM that
  is the `vms` row's `billedTo` and `usageSeq` advancing under the condition `billedTo = :prev AND usageSeq = :n`,
  so an interval can be neither lost nor written twice.
- There is no `deliveries` item for usage.
- **The ULID's time is the write's time.** The tier mints the ULID immediately before the `TransactWriteItems`,
  runs that write under a 5 s deadline (SDK retries included), and re-mints on any retry. A DynamoDB transaction
  commits within its request, so a ULID's time is within ≈ 5 s of its commit, against a watermark 2 heartbeats
  (≈ 20 s) back; tier clock skew is milliseconds. That is what lets the watermark below be safe.
- **Clock assumption:** the watermark assumes the skew between tier tasks' clocks is well under 15 s (Fargate
  NTP keeps it at milliseconds). A task whose clock drifts past that could write below a watermark another task's
  reader has passed. The tier checks its clock against the `Date` header of DynamoDB's responses (second granularity) and refuses a
  usage write when they differ by more than ≈ 5 s, with an alarm on the refusal (ledger L98; decided by the lead,
  2026-11-14, ships with K4d). Refusing is safe: `billedTo` does not advance, and the intervals are re-derived from
  the `vms` row once the clock is fixed, so billing is only delayed, never lost or doubled.

**The route.** `GET /v1/usage?after=<cursor>&limit=1000` →
`{ "events": [ … ], "cursor": "<opaque>", "watermark": "<ulid-time>" }`.
- It returns events in ULID order across the 16 shards, only those **below the watermark**
  (`now − 2 × heartbeat`), so a writer still committing cannot be skipped by a reader that has already passed it.
- The cursor encodes the 16 shard positions. An empty page with an advanced watermark is normal.
- **Runtime tokens only** (`sub` in `runtime:*`, §9.10). Customers reconcile their own bill from the same events
  through the runtime's API, filtered to their payer.

**The poller.** The runtime runs one leased poller per camel-fs deployment, every ≈ 20 s.
- One Postgres transaction per page: `INSERT … ON CONFLICT (id) DO NOTHING` for every event (on `eventId`), plus the
  cursor advance. A crash replays the page, and the insert absorbs the replay.
- Pricing and charging then run from those rows exactly as the meter does today.
- The inbound usage webhook is deleted. A poller that falls behind by more than the 35-day TTL loses events, so its
  lag is an alarm (`usage_poll_lag`) long before that.

**The credit deadline is a lease, and a lapsed one is final** (camel-fs-compute.md §4): no extension revives a
VM's lease once `now ≥ deadline`, so the usage events never cover time the runtime did not extend credit for.

**Notifications stay pushed.** `vm.ended` and ref moves remain on §9.11's webhook outbox. `vm.ended` is a hint:
if one is lost, the next poll's final `usage.vm` event and `GET /v1/vms/{id}` reconcile the job.
