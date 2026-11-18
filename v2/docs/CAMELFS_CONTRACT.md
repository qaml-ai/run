# `camelfsd` v2 Wire Contract (`worker` <-> `camelfsd`)

`camelfsd` is a standalone Go service providing **Git-backed content-addressable repositories** (lineages, refs, leases, commits, trees, blobs, diff/merge/grep) and **session VMs** (persistent bash shells over `/workspace` with atomic post-command commits).

---

## 1. Authentication

Every request from the Worker carries `Authorization: Bearer <token>`:
- **Ed25519 JWT (`alg: "EdDSA"`, `typ: "camelfs+jwt"`, `kid: "<keyId>"`)**:
  - Claims: `{ "iss": "camelrun", "sub": "<tenantId>", "lin": "<lineage>|*", "scopes": ["repo:read", "repo:write", "vm:exec"], "exp": <unixSec> }`
  - `camelfsd` verifies signatures against `--public-keys <kid>:<base64url-32-byte-ed25519-pubkey>[,...]`.
- **Dev/local shared secret fallback**: when `--dev-token <secret>` is configured on `camelfsd`, `Authorization: Bearer <secret>` is also accepted (with optional `X-Camel-Tenant` header).
- `GET /healthz` -> `200 {"ok": true}` (unauthenticated).

Errors always return JSON:
```json
{ "error": { "code": "not_found | cas_conflict | ref_leased | invalid_request | unauthorized | timeout | internal", "message": "..." } }
```

---

## 2. Repository / Lineage Endpoints

### `POST /v1/lineages`
Creates or ensures a lineage with an initial empty commit on `refs/heads/main`.
- Request: `{ "lineage"?: string, "tenantId"?: string }` (generates `lin_<hex>` if omitted)
- Response `200`:
```json
{ "lineage": "lin_...", "defaultRef": "refs/heads/main", "commit": "<sha256>", "tree": "<sha256>" }
```

### `DELETE /v1/lineages/{lineage}`
Stops any active VMs on the lineage, marks it deleted, and purges refs/objects.
- Response `200`: `{ "deleted": true }`

### `POST /v1/lineages/{lineage}/fork`
Creates `targetLineage` initialized from `sourceRef` (default `refs/heads/main`), copying/sharing reachable objects so both lineages evolve independently.
- Request: `{ "targetLineage"?: string, "sourceRef"?: string, "targetRef"?: string, "atCommit"?: string }`
- Response `200`: `{ "lineage": "lin_...", "ref": "refs/heads/main", "commit": "<sha256>", "tree": "<sha256>" }`

### `GET /v1/lineages/{lineage}/refs?prefix=refs/heads/`
- Response `200`:
```json
{
  "refs": [
    {
      "name": "refs/heads/main",
      "commit": "<sha256>",
      "tree": "<sha256>",
      "updatedAt": 1763400000000,
      "lease": { "holder": "agt_123", "epoch": 2, "expiresAt": 1763400600000 }
    }
  ]
}
```

### `POST /v1/lineages/{lineage}/refs`
Creates, branches, updates, or deletes a ref with optional CAS & lease checks.
- Request: `{ "ref": "refs/heads/feat", "commit": "<sha256>", "expectedCommit"?: "<sha256>", "holder"?: string, "delete"?: boolean }`
- Response `200`: `{ "ref": "refs/heads/feat", "commit": "<sha256>", "tree": "<sha256>" }`

### `POST /v1/lineages/{lineage}/lease`
Acquires, renews, or releases a writer lease on `ref`.
- Request: `{ "ref": "refs/heads/main", "holder": "agt_123", "ttlMs": 600000, "release"?: boolean }`
- Response `200`: `{ "ref": "refs/heads/main", "commit": "<sha256>", "tree": "<sha256>", "holder": "agt_123", "epoch": 3, "expiresAt": 1763400600000 }`

### `POST /v1/lineages/{lineage}/write`
Atomic multi-file write/delete/move producing a commit on `ref`.
- **Important seamless VM rule**: if an active VM leased by the **same `holder`** is currently running on `(lineage, ref)`, `camelfsd` applies the file changes directly into that VM's live `/workspace` AND commits the updated tree to `ref` — so file tools (`write`/`edit`/`delete`/`mv`) and `bash` never conflict for the owning agent! If leased by a *different* holder, returns `409 { "error": { "code": "ref_leased", ... } }`.
- Request:
```json
{
  "ref": "refs/heads/main",
  "expectedCommit": "<optional sha256>",
  "holder": "agt_123",
  "author": "agent:agt_123",
  "message": "write src/index.ts",
  "puts": [{ "path": "src/index.ts", "content": "console.log(1)\n", "base64": "<optional>", "mode": 420 }],
  "deletes": ["old.txt"],
  "moves": [{ "from": "a.txt", "to": "b.txt" }]
}
```
- Response `200`:
```json
{ "commit": "<sha256>", "tree": "<sha256>", "changed": ["src/index.ts", "old.txt", "a.txt", "b.txt"], "totalBytes": 15 }
```

### `GET /v1/lineages/{lineage}/read?at=refs/heads/main&path=src/index.ts&offset=0&limit=65536`
- Response `200`:
```json
{ "commit": "<sha256>", "path": "src/index.ts", "size": 15, "mode": 420, "binary": false, "content": "console.log(1)\n", "base64": null }
```

### `GET /v1/lineages/{lineage}/ls?at=refs/heads/main&path=&recursive=1&glob=**/*.ts`
- Response `200`:
```json
{ "commit": "<sha256>", "entries": [{ "path": "src/index.ts", "type": "file", "size": 15, "mode": 420, "hash": "<sha256>" }] }
```

### `POST /v1/lineages/{lineage}/grep`
- Request: `{ "at": "refs/heads/main", "pattern": "console\\.log", "pathPrefix"?: "src/", "maxMatches"?: 100 }`
- Response `200`:
```json
{ "commit": "<sha256>", "matches": [{ "path": "src/index.ts", "line": 1, "column": 1, "text": "console.log(1)" }] }
```

### `GET /v1/lineages/{lineage}/history?ref=refs/heads/main&limit=20`
- Response `200`:
```json
{ "commits": [{ "commit": "<sha256>", "tree": "<sha256>", "parents": ["<sha256>"], "author": "agent:agt_123", "message": "...", "createdAt": 1763400000000 }] }
```

### `GET /v1/lineages/{lineage}/diff?from=<refOrCommit>&to=<refOrCommit>`
- Response `200`:
```json
{ "fromCommit": "<sha256>", "toCommit": "<sha256>", "changes": [{ "path": "src/index.ts", "kind": "added", "oldHash": "", "newHash": "<sha256>", "patch": "+console.log(1)\n" }] }
```

### `POST /v1/lineages/{lineage}/restore`
- Request: `{ "ref": "refs/heads/main", "targetCommit": "<sha256>", "holder"?: "agt_123", "author": "agent:agt_123", "message": "restore" }`
- Response `200`: `{ "commit": "<sha256>", "tree": "<sha256>" }` (also updates live VM `/workspace` if held by `holder`).

### `POST /v1/lineages/{lineage}/merge`
- Request: `{ "sourceRef": "refs/heads/feat", "targetRef": "refs/heads/main", "strategy": "three-way | ff-only | squash", "holder"?: "agt_123", "author": "workflow", "message": "merge feat" }`
- Response `200` (or `409` on conflict): `{ "commit": "<sha256>", "tree": "<sha256>", "conflicts": [] }`

---

## 3. Session VM Endpoints (1 VM per `(lineage, ref)`, Atomic Exec + Commit)

### `POST /v1/vms`
Finds the running VM for `(lineage, ref)` when `holder` matches, or starts one from the ref's head commit. The direct Firecracker driver attaches the commit's ext4 disk map and fetches chunks on demand. The local and outbound host drivers receive the file tree.
- Request:
```json
{
  "lineage": "lin_...",
  "ref": "refs/heads/main",
  "holder": "agt_123",
  "vcpus": 2,
  "memoryMiB": 2048,
  "idleTimeoutS": 30,
  "leaseS": 600,
  "env": { "CI": "1" }
}
```
- Response `200`:
```json
{
  "vmId": "vm_...",
  "lineage": "lin_...",
  "ref": "refs/heads/main",
  "holder": "agt_123",
  "state": "running",
  "headCommit": "<sha256>",
  "reused": false,
  "leaseExpiresAt": 1763400600000
}
```

### `POST /v1/vms/{vmId}/exec`
Runs `command` in the VM's **persistent bash shell** (preserving `cwd` and exported environment variables across calls!) and publishes any `/workspace` changes, updated VM accounting, and the execution receipt in one transaction before returning. Idempotent by `execId`.
- Request:
```json
{
  "execId": "exec_...",
  "command": "echo hi > hello.txt && pwd",
  "cwd": "/workspace",
  "env": {},
  "timeoutS": 60,
  "commit": { "author": "agent:agt_123", "message": "bash: echo hi", "skip": false }
}
```
- When `Accept: text/event-stream`: emits SSE events `event: stdout` (`{"chunk":"..."}`), `event: stderr` (`{"chunk":"..."}`), and final `event: result` (`{...}`).
- When `Accept: application/json` (default): returns `200`:
```json
{
  "execId": "exec_...",
  "exitCode": 0,
  "stdout": "/workspace\n",
  "stderr": "",
  "cwd": "/workspace",
  "timedOut": false,
  "durationMs": 14,
  "billableMs": 14,
  "commit": {
    "changed": true,
    "commit": "<newSha256>",
    "tree": "<newTreeSha256>",
    "filesChanged": ["hello.txt"]
  }
}
```

A replay with an existing execution receipt returns that receipt. An exec against a
lost VM without a receipt returns HTTP 410 with code `vm_lost`. The interrupted
command may have run. A new boot starts from the last committed workspace.

### `POST /v1/vms/{vmId}/lease`
- Request: `{ "leaseS": 600 }`
- Response `200`: `{ "vmId": "vm_...", "state": "running", "leaseExpiresAt": 1763400600000 }`

### `POST /v1/vms/{vmId}/stop`
Commits any uncommitted `/workspace` edits on a running VM, releases the ref lease, and stops it.
If the VM was lost, returns its `lost` state and the last committed workspace.
- Response `200`: `{ "vmId": "vm_...", "state": "stopped", "commit": "<sha256>", "unbilledMs": 120 }`

### `GET /v1/vms/{vmId}`
- Response `200`: `{ "vmId": "vm_...", "lineage": "lin_...", "ref": "refs/heads/main", "holder": "agt_123", "state": "running | stopped | lost", "headCommit": "<sha256>", "leaseExpiresAt": 1763400600000 }`

---

## 4. Outbound Compute Host Multiplexing (`/v1/hosts/*`)

Compute hosts need **zero inbound open ports and zero Private CA**:
- Hosts register/heartbeat outbound via `POST /v1/hosts/heartbeat` + long-poll/stream `GET /v1/hosts/{hostId}/commands` + `POST /v1/hosts/{hostId}/results` authenticated with `--host-token` or AWS STS identity.
- When `camelfsd` runs in single-node mode (`--vm-driver=local` or `--vm-driver=firecracker` directly), it executes VM operations locally via the same `vm.Driver` interface with zero network hops.
