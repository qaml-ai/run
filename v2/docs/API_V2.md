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

### Repos (`/v2/repos`)
- `POST /v2/repos`: `{ name? }` -> `{ repoId, lineage, defaultRef: "refs/heads/main", commit }`
- `GET /v2/repos` / `GET /v2/repos/:repoId` / `DELETE /v2/repos/:repoId`
- `GET /v2/repos/:repoId/files?at=&path=` / `POST /v2/repos/:repoId/write` / `GET /v2/repos/:repoId/ls` / `POST /v2/repos/:repoId/grep` / `GET /v2/repos/:repoId/diff` / `GET /v2/repos/:repoId/history`

### Durable Keyed Agents (`/v2/agents`)
- `PUT /v2/agents/:key` (`upsert`):
  ```json
  {
    "model": "openrouter/meta/muse-ember",
    "instructions": "Be concise.",
    "definition": "optional-slug",
    "tools": [{ "name": "lookupOrder", "description": "...", "parameters": { "type": "object", ... }, "url": "optional-webhook-url", "requiresApproval": false }],
    "mcpServers": [{ "name": "docs", "url": "https://..." }],
    "builtins": ["files", "bash", "codemode", "delegate", "workflows", "web_search", "web_fetch", "human"],
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
    "idempotencyKey": "optional",
    "whileRunning": "queue | steer",
    "wait": true,
    "outputSchema": { ... },
    "maxSteps": 25
  }
  ```
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
- `POST /v2/webhooks` / `GET /v2/webhooks` / `DELETE /v2/webhooks/:id` (HMAC-SHA256 `X-CamelRun-Signature` via Cloudflare Queue).
