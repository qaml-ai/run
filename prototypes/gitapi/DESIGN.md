# camelRun volumes as a programmable git API we own (Workers + DO + R2)

A decision aid, not a migration plan. It is the "Pierre code.storage, but ours" arm of the volume prototypes: a git
repository whose **writes are API calls** (a file map in, a commit out; two branch names in, a merge out), whose
**reads are API calls** (file, tree, diff, log), and which speaks the git wire protocol **read-only, for jobs**.
Nobody outside the service builds a pack, a tree or a commit. Siblings: `prototypes/artifacts-volumes/` (Cloudflare
Artifacts, and an own *push-based* git server); this one is measured with the same tree generator and sizes.

Code: `src/` (1,061 lines), `test/e2e.test.ts` (real `git` against both the Worker under `wrangler dev` and the Node
server), `bench/bench.ts`. Numbers: `RESULTS.md`.

## The shape in one paragraph

**One Durable Object per repo** holds the refs, the object index (sha → segment, offset, length) and the raw bytes of
every tree and commit in SQLite. **Blob bytes live in R2 "segments"**: each write appends one R2 object holding the
new objects as git pack entries (type/size header + zlib), back to back. A server-side `commit` hashes the given files,
rewrites only the trees on changed paths (from SQLite, no R2 read), writes **one** segment, and moves the ref in **one**
SQLite transaction with a compare-and-swap. A `merge` is three-way by tree, descending only where both sides changed,
diff3 on lines for files both sides edited (the only case that reads blobs). A **branch is a row**; an **ephemeral
branch is a row with `expires_at`**, dropped by the object's alarm, after which reachability GC reclaims its bytes.
A job's **clone or fetch** is answered with a *plan* (byte ranges of segments) that the stateless Worker streams from
R2, hashing as it goes; a full clone is teed into a **cached clone pack per commit**, so the next job's clone is one R2
read. The volume's version is a **tree sha**.

## API surface (exact, as built)

Repo-scoped JSON over HTTPS; the Worker is the auth boundary (tenant → repo name; not built in the prototype).

| endpoint | does | notes |
|---|---|---|
| `POST /repos/:r/commits` `{branch, message, files: {path: {content}\|{base64}\|{sha}\|null}, expectedHead?, expect?: {path: sha\|null}, from?}` | file map → commit | `expectedHead`: whole-branch CAS (`null` = branch must not exist). `expect`: **per-file** CAS against the head (what today's per-file versions do). `{sha}` reuses a blob without re-sending bytes. `from` seeds a new branch. No-op commits return the head. → `{commit, tree, parents, objectsWritten, bytesWritten}` |
| `POST /repos/:r/branches` `{name, from?, ttlSeconds?}` | branch (ephemeral with a TTL) | one row; fails if it exists |
| `PATCH /repos/:r/branches/:name` `{ttlSeconds}` | extend an attempt's lease | |
| `DELETE /repos/:r/branches/:name?expected=sha` | drop a branch | objects go at the next GC |
| `POST /repos/:r/merges` `{into, from, squash?, deleteSource?, expectedHead?, message?}` | three-way merge | `up-to-date` / `fast-forward` (zero bytes) / `merged` (two parents, or one with `squash`) / **409** `{conflicts: [{path, base, ours, theirs, reason}]}` with nothing written |
| `GET /repos/:r/files/<path>?ref=` | raw bytes | headers `x-sha`, `x-mode`, `x-commit`; one R2 range read |
| `GET /repos/:r/tree?ref=&path=&recursive=1` | listing with shas and modes | SQLite only |
| `GET /repos/:r/diff?from=&to=` | changed paths `{path, status, oldSha, newSha}` | tree walk skipping equal subtrees; SQLite only |
| `GET /repos/:r/log?ref=&limit=` | first-parent history | SQLite only |
| `PUT/GET/DELETE /repos/:r/worktree/<path>?branch=` (`x-expect-sha`) | the working layer (below) | a write is one SQLite row |
| `GET /repos/:r/worktree?branch=` / `POST …?branch=&message=` | dirty paths / **checkpoint** them into one commit | |
| `GET /repos/:r/refs`, `GET /repos/:r/stats`, `POST /repos/:r/gc {graceMs?, repackBelow?}`, `DELETE /repos/:r` | admin | |
| `GET /git/:r.git/info/refs?service=git-upload-pack`, `POST /git/:r.git/git-upload-pack` | clone/fetch for jobs | smart HTTP v1, stateless: `multi_ack_detailed`, `shallow`/`deepen N`, `allow-reachable-sha1-in-want`; **no receive-pack** |

Not built, and what they'd be: `previewMerge` (= `merge` that never writes; the conflict path already is that),
`restore` (a commit whose tree is an old tree: `files` from a `diff`, or a `tree` field on `commit`), `grep` (trigram
index over text blobs in the object, as in `swarm-workflows.md`), `archive` (tar of a tree, streamed by the Worker from
the same plan as a clone), webhooks (the object emits `ref.updated` to a Queue after the transaction), GitHub sync
(below), auth tokens (HMAC over `(repo, scope, refs, expiry)` checked in the Worker, ~50 lines).

## Mapping our concepts

| today | git API |
|---|---|
| volume | repo, branch `main` |
| volume version / snapshot | commit sha (history, rollback, diff for free) |
| result-cache key | **tree sha** of the commit a job ran at: equal content = equal key across rollbacks, no-op merges and undiverged forks |
| fork for a workflow child (`seed` pins + `ForkJanitor`) | `POST /branches {name: "fork/<effect>", from: "main", ttlSeconds}`: one row, nothing pinned, nothing copied; the TTL is the janitor |
| `commit()` of a fork (refuses any path both sides touched) | `POST /merges {into: "main", from: "fork/<effect>", squash: true, deleteSource: true}`: disjoint hunks of one file merge; overlapping ones come back as conflicts with both blob shas |
| per-file versions on write | `x-expect-sha` / `expect` (blob sha the writer read) |
| `camel-sync` tar of the whole tree into a job | `git clone --depth 1` from `/git/:r.git` (cached pack per commit); a warm host mirror does a plain `git fetch` of the delta |
| a job's writes back | the job host diffs its checkout (`git status --porcelain -z`) and posts a `commit` (or `checkpoint`) with `expect` = the blob shas it started from; or, later, a scoped receive-pack (the sibling's server shows it is ~200 lines) |
| `push()` to GitHub | GitHub sync (below) |
| snapshot TTLs, pins, GC | one rule: reachable from a ref, else gone |

## How agents' file tools use it: a working layer **inside** the repo object

Agents edit single files thousands of times an hour. A commit per edit works (one R2 PUT + one transaction, ~4 ms of
CPU) but buys history nobody wants and an R2 class-A op per keystroke. So the object keeps a **worktree per branch**:
a write is one SQLite row (inline up to 1 MiB; bigger files become their own segment at write time and the row keeps
the sha), reads see dirty rows over the head, `x-expect-sha` gives per-file optimistic concurrency, and `checkpoint`
turns the rows into one commit. Checkpoint at the end of a turn that wrote, before a job reads the volume, before a
fork, and by alarm after N seconds dirty. Because the layer lives in the **same** object as the refs, there is no
second object, no cache to keep coherent and no "dirty layer vs remote" split-brain (the Artifacts arm needs all
three). An agent's direct-API option stays available (`commit` with a file map) for tools that write many files at
once.

Long agent attempts that want history of their own use an **ephemeral branch** as the session's worktree target and
squash-merge it at the end; their intermediate commits become garbage when the branch expires.

## GC by reachability, and ephemeral expiry

- The alarm drops refs past `expires_at`, then runs `gc`: mark from every ref (commit parents, trees from SQLite;
  blobs are leaves, never read), delete unreachable index rows older than a grace (60 s in the Worker: protects a write
  whose rows are inserted after its segment lands; writers and GC also share one lock), delete segments with nothing
  live, **rewrite** segments under 50 % live (new segment written first, rows repointed in one transaction, old one
  deleted after), drop cached clone packs of commits no ref points at.
- Cost is proportional to **distinct trees and index rows**, not files × commits: 42 ms CPU for the 5k-file repo,
  518 ms for 50k (RESULTS). Past ~500k objects the mark needs paging across alarm invocations.
- Squash merges keep `main`'s history one commit per accepted attempt; a fork's checkpoints die with the fork.
- What GC cannot do: shorten `main`'s own history. That needs a server-side rewrite (graft old history into a new
  root) — possible, and because cache keys are tree shas it would not invalidate any cache, but it changes commit
  shas held by clones. Not built; a retention policy decision.

## Cost at list prices

R2 $0.015/GB-month, class A $4.50/M, class B $0.36/M; DO $0.15/M requests, SQLite $1.00/M rows written, $0.20/GB-month.

| workload (per month) | ops | cost |
|---|---|---|
| 144M agent file writes (1,000 agents × 200/h) via worktree | 1 DO request + 1 row each | **≈ $166** (today: an R2 PUT per write ≈ $648 + rows) |
| 14.4M checkpoints (1,000 agents × 20/h) | 1 R2 PUT + ~8 rows (blobs, trees on path, commit, ref) + 1 request | ≈ $65 + $115 + $2 = **≈ $180** |
| 1M job clones, warm cache | 1 class B + 1 DO request | **≈ $0.50** (Artifacts: $150) |
| 1M job clones, cold | ~1 class B per 8 MiB of pack + one PUT for the cache | ≈ $5 + $4.50 per first clone of a commit |
| 1M incremental fetches | a few class B (coalesced ranges) | ≈ $1–3 |
| 0.5 TB stored (10k volumes × 50 MB with history) | | **$7.50** R2 + trees/commits in SQLite (~4 % of bytes) ≈ $4 |
| cached clone packs | one per head commit per depth, dropped when the head moves | ≈ the repo's compressed size per live head |

The cost driver is SQLite rows written on checkpoints, not R2. Batching trees into one row per commit (a "tree
segment" blob) would cut it ~5×; not worth it until it shows up on a bill.

## Lines we'd own

Prototype: `repo.ts` 554 (refs, commit, worktree, merge, reads, upload-pack planning, GC), `http.ts` 165 (routes,
streaming pack writer, clone cache tee), `objects.ts` 100, `merge.ts` 77 (diff3, from the sibling), `worker.ts` 71,
`node.ts` 94. Production, with auth tokens, webhooks, GitHub sync, `restore`/`previewMerge`/`grep`/`archive`, limits,
streaming commit bodies, metrics and tests: **~2,500–3,000 lines**. It replaces `volume.ts` + `volume-commit.ts` +
`volume-policy.ts` + `workflow-forks.ts` + `workflow-volumes.ts` + `jobs/camel-sync.ts` (1,560 lines) plus the pins
and snapshot-TTL machinery, with a format every tool reads. Compared with the sibling's push-based server, this one
has **no pack parser and no delta resolution** (nobody pushes): the hardest and most memory-hungry part of a git
server is simply absent.

## Better than today

1. **Forks are a row**, merges are three-way (disjoint hunks of one file merge), cleanup is a TTL; pins, snapshot
   TTLs and `ForkJanitor` collapse into reachability GC.
2. **Jobs get the tree by `git clone`**: a cached pack per commit is one R2 read streamed by a stateless Worker; a warm
   host fetches only the delta (3 files: 50–200 ms end to end locally, ~2 ms of server CPU at any tree size). Today: a Worker-built tar fed by one R2 GET per file.
3. **History, diff, log, rollback, clone-to-laptop** for every volume; diff/tree/log are SQLite-only (ms).
4. **Cache key is content** (tree sha).
5. **Agent writes get cheaper**: a SQLite row instead of an R2 PUT.
6. Versus Artifacts: no 1 GB/32 MiB caps, R2 prices, a server-side write API (we write packs either way, but here
   only our own server does), and the working layer sits next to the refs instead of in front of a remote.

## Worse than today

1. **One object per repo is a write bottleneck**: every commit, merge and worktree write serialises there. Fine for
   a volume (one agent, or a workflow's children merging at the end); a hot shared repo with dozens of writers would
   need per-branch objects with the ref CAS moved to a small coordinator.
2. **Big files**: a commit body is held in memory (a Worker request is ≤100 MB, the object has 128 MB). Imports must be
   batched (the bench uses 2,500 files ≈ 25 MB per commit) or come in through a streamed upload. Files > 1 MiB skip the
   worktree inline path; files > ~50 MB need a multipart path to R2 (not built). Today's volumes take 256 MiB files.
3. **Owning a storage system**: GC correctness (a wrong sweep loses data; mitigated by grace, the shared lock and
   write-segment-before-rows ordering), on-call, repack tuning. R2 and DO SQLite give durability; the logic is ours.
4. **Protocol surface**: v1 only (no protocol v2 / partial clone `filter=blob:none`), no side-band progress. Git clients
   fall back silently; jobs don't care.
5. **History grows forever** on `main` unless we add a rewrite/retention policy.
6. **Cold blob reads are an R2 range read** (as today); the worktree makes recent writes free, but the first read of a
   cold file in a turn still costs one R2 GET.

## Node and self-host

The core is platform-neutral: `RepoCore(sql, bucket, prefix)` where `Sql` is `exec` + `tx` and `Bucket` is
`put/get(range)/delete` (+ two stream methods for the front). `src/node.ts` runs the same API with `node:sqlite` per
repo and segments as files on disk — that is what the bench's CPU column measures, and it passes the same end-to-end
test as the Worker. Self-host is therefore one process, a data directory, and git clients for jobs; an S3 bucket
replaces the directory by implementing four methods. A bare git repo export (`git clone --mirror` from our own
endpoint) is the operator's backup and escape hatch.

## GitHub sync

- **Push (mirror out):** a job with a GitHub App installation token does `git clone --mirror <ours>` + `git push
  <github> main` — v1, no new code. A native path (the object builds a thin pack of objects GitHub lacks, walking
  `diff` from GitHub's head) reuses `SegmentWriter`'s entries verbatim; ~150 lines when wanted.
- **Pull (import/upstream):** a job clones from GitHub and posts the tree as `commit` batches (what the bench does), or
  a receive-pack endpoint accepts it (the sibling's parser). Upstream changes land on a branch `upstream/main` and are
  merged into `main` with the same three-way merge.
- Ephemeral branches are never mirrored (sync is per named branch).

## Verdict for this arm

Strong fit for camelRun's model: the agent path is a SQLite row, forks/merges/GC are one coherent mechanism, jobs get
standard git with cached packs, and it runs on what we already operate (DO + R2) with a credible Node story. The risks
are owning GC and a single-writer object per repo; neither is new compared with today's Volume DO.
