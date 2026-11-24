# camelRun v2 API & WebSocket Protocol (`worker` <-> `sdk`)

Clean-slate v2 HTTP + WebSocket protocol served by the Cloudflare Worker (`Hono`) at `/v2/*`.

---

## 1. Authentication

- **Tenant API Key**: `Authorization: Bearer cr_live_<tenantId>.<id>_<secret>` (routed directly to `TenantDO(tenantId)`, hashed with SHA-256 in DO SQLite `api_keys`). Grants full tenant management + agent execution.
- **Agent Scoped Token**: `Authorization: Bearer agt_tok_<tenantId>.<agentId>.<secret>` (routed directly to `TenantDO` / `AgentDO`, hashed in `agents_index`). Grants running/streaming/answering inputs on that single agent only (`DELETE` and config escalations return `403`).
- **Bootstrap / Admin (`X-Admin-Key: <ADMIN_SECRET>`)**: `POST /v2/tenants` initializes a new `TenantDO`, initial credit grant, and first API key.

Standard error envelope:
```json
{ "error": { "code": "...", "message": "..." } }
```

---

## 2. Core Endpoints

### Tenants, Keys, Providers, Billing & Definitions
- `POST /v2/tenants` (admin): `{ name, initialCreditsUsd?: number }` -> `{ tenantId, name, apiKey, balanceUsd }`
- `GET /v2/me`: `{ tenantId, name, balanceUsd, tier, busyAgents: { active, limit } }`
- `POST /v2/tokens` / `GET /v2/tokens` / `DELETE /v2/tokens/:id`
- `PUT /v2/providers/:provider`: `{ apiKey, baseUrl?: string }` (AES-GCM sealed with `VAULT_SECRET` in D1)
- `GET /v2/billing`: `{ balanceUsd, monthlyCapUsd, usage: [...] }`
- `POST /v2/billing/credits` (admin/topup): `{ amountUsd, refId, note? }` -> `{ balanceUsd }`
- `PUT /v2/definitions/:slug` / `GET /v2/definitions` / `DELETE /v2/definitions/:slug`

### Domain Skills (`/v2/skills`)
Tenant-scoped progressive-disclosure skills stored in `TenantDO` SQLite. Slugs follow `^[a-z0-9][a-z0-9/_-]{0,127}$` (supports flat slugs like `sql-storage` and slash-namespaced slugs like `camel-bots/sql-storage`; no `..`, no leading/trailing `/`). Each skill is capped at 512 KiB total across `markdown` (`SKILL.md`) and up to 50 relative reference files in `files`.
- `PUT /v2/skills/:slug` (upsert; supports slash-namespaced slugs like `PUT /v2/skills/camel-bots/sql-storage`):
  ```json
  {
    "name": "optional-override (else YAML frontmatter name or slug leaf)",
    "description": "optional-override (required from body or SKILL.md YAML frontmatter)",
    "tags": ["optional", "tags"],
    "markdown": "---\nname: sql-storage\ndescription: SQL storage rules\ntags: [storage, sql]\n---\n\n# SQL Storage\n...",
    "files": {
      "references/sdk.d.ts": "export interface SqlStorage { ... }"
    }
  }
  ```
  Computes a canonical SHA-256 `contentHash` and increments `version` only when content changes (idempotent when unchanged). Returns `{ slug, name, description, tags, version, contentHash, files: string[], createdAt, updatedAt }`.
- `GET /v2/skills?prefix=&tag=`: lists metadata summaries deterministically sorted by `slug`.
- `GET /v2/skills/:slug`: returns full skill `{ slug, name, description, tags, version, contentHash, markdown, files: Record<string, string>, createdAt, updatedAt }` (`404 skill_not_found` if missing).
- `DELETE /v2/skills/:slug`: deletes a skill and returns `{ ok: true, deleted: boolean }`.

### Repos (`/v2/repos`)
- `POST /v2/repos`: `{ name? }` -> `{ repoId, lineage, defaultRef: "refs/heads/main", commit }`
- `GET /v2/repos` / `GET /v2/repos/:repoId` / `DELETE /v2/repos/:repoId`
- `GET /v2/repos/:repoId/files?at=&path=` / `POST /v2/repos/:repoId/write` / `GET /v2/repos/:repoId/ls` / `POST /v2/repos/:repoId/grep` / `POST /v2/repos/:repoId/restore` / `GET /v2/repos/:repoId/history`

### Durable Keyed Agents (`/v2/agents`)
- `PUT /v2/agents/:key` (`upsert`):
  ```json
  {
    "model": "openrouter/meta/muse-ember",
    "instructions": "Be concise.",
    "definition": "optional-slug",
    "tools": [{ "name": "lookupOrder", "description": "...", "parameters": { "type": "object", ... }, "url": "optional-webhook-url", "requiresApproval": false }],
    "mcpServers": [{ "name": "docs", "url": "https://..." }],
    "builtins": ["files", "bash", "codemode", "delegate", "workflows", "web_search", "web_fetch", "human", "skills"],
    "skills": ["camel-bots/*", "custom-skill"],
    "queue": { "mode": "each | batch", "windowMs": 0 },
    "repoId": "optional-repo-id",
    "branch": "refs/heads/main",
    "spendLimitUsd": 10,
    "idleTtlSeconds": 86400,
    "dreaming": { "enabled": false, "idleSeconds": 3600 }
  }
  ```
  Returns `{ id, key, agentToken, repoId, branch, model, created: boolean }`.
- `GET /v2/agents` / `GET /v2/agents/:idOrKey` / `DELETE /v2/agents/:idOrKey`
- `POST /v2/agents/:idOrKey/runs` (start or await a run):
  ```json
  {
    "prompt": "Fix failing test",
    "actor": "optional-app-user-id",
    "idempotencyKey": "optional",
    "whileRunning": "queue | steer",
    "wait": true,
    "outputSchema": { ... },
    "maxSteps": 25,
    "spendLimitUsd": 0.25
  }
  ```
  The optional `spendLimitUsd` stops a run when metered usage reaches the limit. Charges from a model response or VM command that crosses the limit still count. A limit of zero stops the run before calling the model. A request that supplies a limit must use `whileRunning: "queue"`. Steering an active run keeps its existing limit.

  A tenant credential can set `actor` to an application user it has authenticated. Signed tool calls include that actor in `act` and keep the configured agent subject in `sub`. Runs with a limit or an actor execute individually in batch mode. A steer from a different actor queues as its own run.

  Returns `RunRecord`:
  ```json
  {
    "id": "run_...",
    "agentId": "agt_...",
    "status": "queued | running | input_required | completed | failed | cancelled",
    "text": "...",
    "output": null,
    "batchedInto": null,
    "inputs": [],
    "toolCalls": [{ "id": "...", "name": "...", "ok": true }],
    "filesChanged": [],
    "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "vmMs": 0 },
    "error": null
  }
  ```
- `GET /v2/agents/:idOrKey/runs/:runId`
- `POST /v2/agents/:idOrKey/abort`: `{ keepQueued?: boolean }`
- `GET /v2/agents/:idOrKey/events?after=0&runId=` (SSE when `Accept: text/event-stream`, JSON page otherwise)
- `GET /v2/agents/:idOrKey/ws` (**Hibernatable WebSocket**; accepts `Authorization: Bearer ...` header OR `?token=<bearer>` query parameter for browser/standard `WebSocket` clients):
  - Streams live agent events (`{"type":"event","seq":...,"runId":...,"event":...}`).
  - **Bidirectional SDK Attached Tool Protocol**:
    - SDK sends `{"type":"register_tools","tools":["lookupOrder"]}` on connect.
    - When `AgentDO` invokes an attached tool with no static `url`, `AgentDO` sends `{"type":"tool_call","callId":"...","name":"lookupOrder","args":{...}}` to the connected tool socket and awaits `{"type":"tool_result","callId":"...","result":{...},"error":null}`!
- `GET /v2/agents/:idOrKey/history?after=0&limit=50`
- `POST /v2/agents/:idOrKey/compact` & `POST /v2/agents/:idOrKey/reset-context`: `{ summary?: string, keepLast?: number }`
- `POST /v2/agents/:idOrKey/fork`: `{ key?: string, atSeq?: number }` -> creates forked agent + forked `camelfs` repo/lineage!
- `POST /v2/agents/:idOrKey/inputs/:inputId`: `{ approved?: boolean, answer?: unknown }` -> resumes paused `input_required` run!
- `POST /v2/agents/:idOrKey/schedules` / `GET /v2/agents/:idOrKey/schedules` / `DELETE /v2/agents/:idOrKey/schedules/:scheduleId`
- `POST /v2/agents/:idOrKey/workflows`: `{ code: "const a = await wf.agent(...); return a;", idempotencyKey?: string, wait?: boolean }` -> deterministic replay workflow execution!
- `POST /v2/agents/:idOrKey/dream`: triggers an immediate or scheduled memory-consolidation pass writing `/workspace/MEMORY.md`.

### Stateless Runs, Decisions, Voice, Channels, Media & Webhooks
- `POST /v2/runs`: `{ model?, instructions?, input, outputSchema?, tools? }` -> one-shot stateless run without persisting an agent.
- `POST /v2/decisions`: `{ input, choices: ["billing", "technical", "spam"], instructions?, model? }` -> `{ choice, confidence, scores, costUsd }`.
- `POST /v2/voice/sessions`: `{ agentIdOrKey, provider: "openai | elevenlabs", voice?: string }` -> `{ sessionId, provider, clientSecret, wsUrl }` (backed by `VoiceDO`, plus `POST /v2/voice/sessions/:id/tool` bridge to `AgentDO`).
- `POST /v2/channels` / `POST /v2/channels/:id/inbound`: Slack & Email/HTTP inbound routing into keyed channel agents, queuing outbound replies.
- `POST /v2/transcriptions`, `POST /v2/speech`, `POST /v2/images`, `GET /v2/images/:id` (backed by R2).
- `POST /v2/media`: upload a raster image once (raw `image/png`, `image/jpeg`, `image/webp`, or `image/gif`, or JSON `{ data: "<base64>", contentType?: string }`, up to 10 MiB and 4096×4096 px; WebP and GIF first frames are converted to PNG). Returns `{ id, url: "/v2/images/:id?exp=...&sig=...", expiresAt, contentType, width, height, sizeBytes }` where `id` (`img_...`) can be referenced in `POST /v2/images/render` `files`. Uploaded media requires either the owning tenant's bearer token or the short-lived HMAC-signed URL (`Cache-Control: private`; unauthenticated requests return `401` and cross-tenant requests return `404`).
- `GET /v2/media/:id` / `GET /v2/images/:id`: serves tenant media; generated images from `POST /v2/images` remain publicly cacheable, while `POST /v2/media` uploads require tenant bearer auth or a valid signed `?exp=...&sig=...` link.
- `DELETE /v2/media/:id`: deletes a tenant-owned `img_...` object from R2, returning `{ ok: true, id, deleted: true }` (`404 media_not_found` if missing or owned by another tenant).
- `POST /v2/images/render`: `{ svg: string, files?: Record<string, string | { data: string }>, format?: "png" }` returns `{ contentType, width, height, data }` (base64 PNG) and records a zero-cost `resvg` usage row in `GET /v2/billing`. Accepts PNG, JPEG, WebP, and GIF (first frame auto-converted to PNG), up to 1 MiB SVG, 2048×2048 / 4 MP output (max 4096 px side), 16 inputs up to 10 MiB each (14 MiB total base64), and 4,000 `<textbox>` text measurements. See the [SVG rendering guide](../../docs/guides/images.md#rendering-svg-cards-in-v2).
- `POST /v2/moderations/images`: raw `image/jpeg` or `image/png` body (up to 5 MiB). Wraps OpenAI `omni-moderation-latest` fail-closed and returns `{ id, model, flagged, categories, category_scores, category_applied_input_types }`.
- Agent builtins for images: `images` suite provides `render_image` (`{ svg, files?: Record<string, repoPath>, path }`, auto-converting WebP/GIF repo inputs and showing the rendered PNG back to the model); `files` suite provides `view_image` (`{ path, at? }`) for inspecting PNG, JPEG, GIF, or WebP files in the agent repository.
- Agent skills & builtins: attaching `skills: ["camel-bots/*", ...]` (exact slugs, prefix globs, or `"*"`) on an agent or definition resolves matching tenant skills once per turn (plus optional repo-local `.agents/skills/*/SKILL.md` when `files` is enabled), appends a compact deterministically sorted `<skills>` index to system instructions for prompt-cache stability, and automatically enables the `read_skill` (`{ name, file?, start_line?, end_line? }`) and `search_skills` (`{ query, skill?, max_results? }`) tools (also selectable via `builtins: ["skills"]`).
- `POST /v2/webhooks` / `GET /v2/webhooks` / `DELETE /v2/webhooks/:id` (HMAC-SHA256 `X-CamelRun-Signature` via Cloudflare Queue).
