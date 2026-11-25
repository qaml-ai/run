import { DurableObject } from "cloudflare:workers";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { CamelFsClient } from "./camelfs.ts";
import { mintAgentToken, randomId, sealSecret } from "./crypto.ts";
import { PiAgentEngine, type LifecycleJobContext } from "./pi/agent-engine.ts";
import { DEFAULT_MODEL_ID } from "./pi/models.ts";
import { parseRunFiles } from "./run-files.ts";
import { getTenantStub } from "./tenant-do.ts";
import {
  ApiError,
  DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS,
  emptyUsage,
  extractApiError,
  normalizeCompactOnIdleConfig,
  toApiErrorResponse,
  type AgentConfig,
  type AgentEventRecord,
  type CompactOnIdleConfig,
  type Env,
  type PendingInputView,
  type QueueMessagePayload,
  type RpcStub,
  type RunFile,
  type RunRecord,
  type RunStatus,
  type RunUsage,
  type ScheduleRecord,
  type StartRunHints,
  type StartRunInput,
  type StoredMessage,
  type ToolCallSummary,
} from "./types.ts";
import { deliverWebhookMessage, enqueueWebhookEvent } from "./webhooks.ts";
import { executeAgentWorkflow, type WorkflowExecutionSummary } from "./workflows.ts";

interface WsAttachment {
  tools: string[];
}

export function getAgentStub(env: Env, agentId: string): RpcStub<AgentDO> {
  if (!agentId) {
    throw new ApiError(400, "missing_agent", "Missing agent identifier");
  }
  return env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)) as unknown as RpcStub<AgentDO>;
}

interface PendingWsCall {
  ws: WebSocket;
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RUN_WATCH_INTERVAL_MS = 60_000;
const RUN_STALL_AFTER_MS = 5 * RUN_WATCH_INTERVAL_MS;
const RUN_LIFECYCLE_EVENTS = new Set([
  "run_queued", "run_started", "run_resumed", "input_required",
  "run_completed", "run_failed", "run_cancelled",
]);
const EXPECTED_RUN_FAILURES = new Set([
  "insufficient_credits", "run_spend_limit_exceeded", "spend_limit_exceeded", "input_expired",
  "attachment_invalid", "attachment_size",
]);

export class AgentDO extends DurableObject<Env> {
  private sqlReady = false;
  private cachedConfig: AgentConfig | null = null;
  private preRunHints = new Map<string, StartRunHints>();
  private runKeyScopes = new Map<string, string | null>();
  private activeRunId: string | null = null;
  private queueDrain: Promise<void> | null = null;
  private inputResumeWork: Promise<RunRecord> | null = null;
  private destroying = false;
  private storageGeneration = 0;
  private runWaiters = new Map<string, Array<(rec: RunRecord) => void>>();
  private sseListeners = new Set<(ev: AgentEventRecord) => void>();
  private pendingWsCalls = new Map<string, PendingWsCall>();
  private lastDreamedSeq = 0;
  private lastIdleCompactedSeq = 0;
  private repoProvisioning?: Promise<{ repoId: string; lineage: string; branch: string }>;
  private piEngine: PiAgentEngine | null = null;
  private periodicRanInAlarm = false;

  private ensurePiEngine(): PiAgentEngine {
    if (!this.piEngine) {
      this.piEngine = new PiAgentEngine({
        durableObject: this,
        env: this.env,
        ctx: this.ctx,
        getConfig: () => this.requireConfig(),
        readConfigOrNull: () => this.readConfigOrNull(),
        isDestroying: () => this.destroying,
        ensureAgentRepository: () => this.ensureAgentRepository(),
        hasWebSocketTool: (name: string) => this.findSocketForTool(name) !== null,
        invokeWebSocketTool: (name, args, callId) => this.dispatchWebSocketTool(name, args, callId),
        recordAndBroadcastEvent: (runId, type, data) =>
          this.recordAndBroadcastEvent(runId, type, data),
        enqueueAppWebhook: (tenantId, eventType, payload) =>
          this.enqueueAppWebhook(tenantId, eventType, payload),
        scheduleNextAlarm: () => this.scheduleNextAlarm(),
        materializeRunRecord: (runId) => this.materializeRunRecord(runId),
        waitForRunSettlement: (runId) => this.waitForRunSettlement(runId),
        notifyRunWaiters: (runId) => this.notifyRunWaiters(runId),
        setActiveRunId: (runId) => {
          this.activeRunId = runId;
        },
        getActiveRunId: () => this.activeRunId,
        onRunSettled: (runId) => {
          const rec = this.materializeRunRecord(runId);
          const followerIds = this.followerIdsFor(runId);
          if (followerIds.length > 0) {
            this.finalizeFollowers(rec, followerIds);
            for (const fid of followerIds) this.notifyRunWaiters(fid);
          }
          if (!this.destroying && this.sqlReady) {
            this.ctx.waitUntil(this.drainRunQueue());
          }
        },
        runWorkflow: (body) => this.runWorkflow(body),
      });
    }
    return this.piEngine;
  }

  private ensureSql(): void {
    if (this.sqlReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_entry_meta (
        entry_id INTEGER PRIMARY KEY,
        run_id TEXT,
        meta_json TEXT,
        repo_commit TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        status TEXT NOT NULL,
        while_running TEXT NOT NULL DEFAULT 'queue',
        prompt TEXT NOT NULL,
        output_schema_json TEXT,
        batched_into TEXT,
        text TEXT NOT NULL DEFAULT '',
        output_json TEXT,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        files_changed_json TEXT NOT NULL DEFAULT '[]',
        usage_json TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"costUsd":0,"vmMs":0}',
        error_json TEXT,
        max_steps INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, started_at ASC);
      CREATE TABLE IF NOT EXISTS run_files (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        files_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq ASC);
      CREATE TABLE IF NOT EXISTS app_webhook_deliveries (
        id TEXT PRIMARY KEY,
        message_json TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_app_webhook_deliveries_due ON app_webhook_deliveries(next_attempt_at);
      CREATE TABLE IF NOT EXISTS inputs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt_json TEXT NOT NULL,
        status TEXT NOT NULL,
        answer_json TEXT,
        pending_turn_json TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inputs_run ON inputs(run_id, status);
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        interval_seconds INTEGER,
        cron_expr TEXT,
        prompt TEXT NOT NULL,
        next_due_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY,
        child_agent_id TEXT NOT NULL,
        child_agent_key TEXT NOT NULL DEFAULT '',
        parent_run_id TEXT,
        status TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS step_cache (
        scope TEXT NOT NULL,
        step_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope, step_key)
      );
      CREATE TABLE IF NOT EXISTS vm_session (
        branch TEXT PRIMARY KEY,
        vm_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
    const runColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(runs)").toArray();
    if (!runColumns.some((column) => column.name === "spend_limit_usd")) {
      this.ctx.storage.sql.exec("ALTER TABLE runs ADD COLUMN spend_limit_usd REAL");
    }
    if (!runColumns.some((column) => column.name === "actor")) {
      this.ctx.storage.sql.exec("ALTER TABLE runs ADD COLUMN actor TEXT");
    }
    const metaColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(pi_entry_meta)")
      .toArray();
    if (!metaColumns.some((column) => column.name === "repo_commit")) {
      this.ctx.storage.sql.exec("ALTER TABLE pi_entry_meta ADD COLUMN repo_commit TEXT");
    }
    this.sqlReady = true;

    const dreamRow = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM runtime_kv WHERE k = 'last_dreamed_seq' LIMIT 1`)
      .toArray()[0];
    if (dreamRow?.v) {
      this.lastDreamedSeq = Number(dreamRow.v) || 0;
    }

    const idleCompactRow = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM runtime_kv WHERE k = 'last_idle_compacted_seq' LIMIT 1`)
      .toArray()[0];
    if (idleCompactRow?.v) {
      this.lastIdleCompactedSeq = Number(idleCompactRow.v) || 0;
    }

    // Recover queued runs persisted before an isolate restart.
    if (!this.activeRunId && this.readConfigOrNull()) {
      const hasQueued = this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM runs WHERE status = 'queued' LIMIT 1`)
        .toArray();
      if (hasQueued.length > 0) {
        this.ctx.waitUntil(this.drainRunQueue());
      }
    }
  }

  private readConfigOrNull(): AgentConfig | null {
    if (this.cachedConfig) return this.cachedConfig;
    if (!this.sqlReady) {
      const hasConfig = this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config' LIMIT 1")
        .toArray();
      if (hasConfig.length === 0) return null;
    }
    const rows = this.ctx.storage.sql
      .exec<{ config_json: string }>(`SELECT config_json FROM config WHERE id = 1`)
      .toArray();
    if (!rows[0]) return null;
    const parsed = JSON.parse(rows[0].config_json) as AgentConfig;
    // Normalize legacy config rows transparently onto Pi without rejecting existing prod agents
    this.cachedConfig = { ...parsed, engine: "pi" };
    return this.cachedConfig;
  }

  private requireConfig(): AgentConfig {
    const cfg = this.readConfigOrNull();
    if (!cfg) {
      throw new ApiError(404, "agent_not_initialized", "Agent is not initialized");
    }
    return cfg;
  }

  private writeConfig(cfg: AgentConfig): void {
    const now = Math.max(Date.now(), (this.cachedConfig?.updatedAt ?? 0) + 1);
    const normalized: AgentConfig = { ...cfg, engine: "pi", updatedAt: now };
    this.ctx.storage.sql.exec(
      `INSERT INTO config (id, config_json, updated_at)
       VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      JSON.stringify(normalized),
      now,
    );
    this.cachedConfig = normalized;
  }

  private enqueueAppWebhook(tenantId: string, eventType: string, payload: Record<string, unknown>): void {
    const event: Extract<QueueMessagePayload, { kind: "webhook" }> = {
      kind: "webhook", tenantId, eventType, eventId: randomId("evt", 16), createdAt: Date.now(), payload,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO app_webhook_deliveries (id, message_json, next_attempt_at) VALUES (?, ?, ?)",
      event.eventId, JSON.stringify(event), event.createdAt,
    );
  }

  async ensureAgentRepository(): Promise<{
    repoId: string;
    lineage: string;
    branch: string;
  }> {
    this.ensureSql();
    const cfg = this.requireConfig();
    const tenantStub = getTenantStub(this.env, cfg.tenantId);

    if (cfg.repoId && cfg.lineage) {
      return { repoId: cfg.repoId, lineage: cfg.lineage, branch: cfg.branch };
    }

    if (cfg.repoId && !cfg.lineage) {
      const repo = await tenantStub.getRepo(cfg.repoId);
      cfg.lineage = repo.lineage;
      if (!cfg.branch) cfg.branch = repo.defaultRef;
      this.writeConfig({ ...this.requireConfig(), lineage: cfg.lineage, branch: cfg.branch });
      return { repoId: cfg.repoId, lineage: repo.lineage, branch: cfg.branch };
    }

    async function provision(stub: typeof tenantStub) {
      const created = await stub.createRepo({ name: `${cfg.key}-repo` });
      const branch = cfg.branch || created.defaultRef;
      await stub.updateAgentRepo(cfg.id, created.repoId, branch);
      return { repoId: created.repoId, lineage: created.lineage, branch };
    }
    this.repoProvisioning ??= provision(tenantStub);
    try {
      const repo = await this.repoProvisioning;
      this.writeConfig({ ...this.requireConfig(), ...repo });
      return repo;
    } finally {
      this.repoProvisioning = undefined;
    }
  }

  private recordAndBroadcastEvent(
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): AgentEventRecord {
    const now = Date.now();
    const dataJson = JSON.stringify(data);
    this.ctx.storage.sql.exec(
      `INSERT INTO events (run_id, type, data_json, created_at) VALUES (?1, ?2, ?3, ?4)`,
      runId,
      type,
      dataJson,
      now,
    );
    const seqRow = this.ctx.storage.sql
      .exec<{ seq: number }>(`SELECT last_insert_rowid() AS seq`)
      .one();
    const record: AgentEventRecord = {
      seq: Number(seqRow.seq),
      runId,
      type,
      data,
      createdAt: now,
    };
    if (runId && RUN_LIFECYCLE_EVENTS.has(type)) {
      const code = (data.error as { code?: unknown } | undefined)?.code ?? data.code;
      this.logRunLifecycle(runId, type, typeof code === "string" ? code : undefined);
    }

    const wsPayload = JSON.stringify({
      type: "event",
      seq: record.seq,
      runId: record.runId,
      event: {
        type: record.type,
        data: record.data,
        createdAt: record.createdAt,
      },
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(wsPayload);
      } catch {
        // Closed socket
      }
    }

    for (const listener of this.sseListeners) {
      try {
        listener(record);
      } catch {
        // Listener disconnected
      }
    }

    const actor = runId && ["run_started", "run_resumed", "run_completed", "run_failed", "run_cancelled", "input_required"].includes(type)
      ? this.runActor(runId)
      : undefined;
    if (actor) {
      const cfg = this.requireConfig();
      this.enqueueAppWebhook(cfg.tenantId, type === "input_required" ? "run.input_required" : `run.${type.slice(4)}`, {
        agentId: cfg.id,
        agentKey: cfg.key,
        runId,
        actor,
        context: cfg.toolIdentity?.context,
        ...(type === "run_completed" ? { text: data.text } : {}),
        ...(type === "run_failed" ? { error: data.error ?? { code: data.code, message: data.message } } : {}),
      });
      this.ctx.waitUntil(this.scheduleNextAlarm());
    } else if (
      type === "run_completed" ||
      type === "run_failed" ||
      type === "run_cancelled" ||
      type === "input_required" ||
      type === "dream_completed"
    ) {
      const cfg = this.readConfigOrNull();
      if (cfg) {
        const webhookType =
          type === "input_required"
            ? "run.input_required"
            : type.startsWith("run_")
              ? `run.${type.slice(4)}`
              : `agent.${type}`;
        void enqueueWebhookEvent(this.env, cfg.tenantId, webhookType, {
          agentId: cfg.id,
          agentKey: cfg.key,
          runId,
          ...data,
        });
      }
    }

    return record;
  }

  private findSocketForTool(toolName: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment() as WsAttachment | null;
        if (attachment?.tools?.includes(toolName)) {
          return ws;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  private dispatchWebSocketTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<unknown> {
    const ws = this.findSocketForTool(name);
    if (!ws) {
      return Promise.reject(new Error(`No connected WebSocket registered tool '${name}'`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWsCalls.delete(callId);
        reject(new Error(`Timed out waiting for WebSocket tool '${name}' (${callId})`));
      }, 30_000);

      this.pendingWsCalls.set(callId, { ws, resolve, reject, timer });
      try {
        ws.send(
          JSON.stringify({
            type: "tool_call",
            callId,
            name,
            args,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingWsCalls.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureSql();
    const raw =
      typeof message === "string" ? message : new TextDecoder().decode(new Uint8Array(message));
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON WebSocket frame" }));
      return;
    }

    const msgType = parsed.type;
    if (msgType === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    if (msgType === "register_tools") {
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.filter((t): t is string => typeof t === "string")
        : [];
      ws.serializeAttachment({ tools } satisfies WsAttachment);
      ws.send(JSON.stringify({ type: "tools_registered", tools }));
      return;
    }

    if (msgType === "tool_result") {
      const callId = typeof parsed.callId === "string" ? parsed.callId : "";
      const pending = this.pendingWsCalls.get(callId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingWsCalls.delete(callId);
      if (parsed.error) {
        const errMsg =
          typeof parsed.error === "string"
            ? parsed.error
            : JSON.stringify(parsed.error);
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(parsed.result ?? null);
      }
      return;
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    for (const [callId, pending] of this.pendingWsCalls.entries()) {
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        this.pendingWsCalls.delete(callId);
        pending.reject(new Error(`Tool WebSocket closed (${code}): ${reason || "disconnected"}`));
      }
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    for (const [callId, pending] of this.pendingWsCalls.entries()) {
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        this.pendingWsCalls.delete(callId);
        pending.reject(
          error instanceof Error ? error : new Error("WebSocket error during tool call"),
        );
      }
    }
  }

  private readRunRowOrThrow(runId: string) {
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        actor: string | null;
        idempotency_key: string | null;
        status: string;
        while_running: string;
        prompt: string;
        output_schema_json: string | null;
        batched_into: string | null;
        text: string;
        output_json: string | null;
        tool_calls_json: string;
        files_changed_json: string;
        usage_json: string;
        error_json: string | null;
        max_steps: number;
        started_at: number;
        ended_at: number | null;
      }>(`SELECT * FROM runs WHERE id = ?1 LIMIT 1`, runId)
      .toArray();
    if (!rows[0]) {
      throw new ApiError(404, "run_not_found", `Run '${runId}' not found`);
    }
    return rows[0];
  }

  private materializeRunRecord(runId: string): RunRecord {
    const row = this.readRunRowOrThrow(runId);
    const cfg = this.requireConfig();

    const inputRows = this.ctx.storage.sql
      .exec<{
        id: string;
        run_id: string;
        tool_call_id: string;
        kind: "approval" | "question";
        prompt_json: string;
        status: PendingInputView["status"];
        expires_at: number;
      }>(`SELECT id, run_id, tool_call_id, kind, prompt_json, status, expires_at FROM inputs WHERE run_id = ?1 ORDER BY rowid ASC`, runId)
      .toArray();

    const inputs: PendingInputView[] = inputRows.map((ir) => ({
      id: ir.id,
      runId: ir.run_id,
      toolCallId: ir.tool_call_id,
      kind: ir.kind,
      prompt: JSON.parse(ir.prompt_json) as Record<string, unknown>,
      status: ir.status,
      expiresAt: ir.expires_at,
    }));

    return {
      id: row.id,
      agentId: cfg.id,
      ...(row.actor ? { actor: row.actor } : {}),
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      status: row.status as RunStatus,
      text: row.text,
      output: row.output_json ? JSON.parse(row.output_json) : null,
      batchedInto: row.batched_into,
      inputs,
      toolCalls: JSON.parse(row.tool_calls_json) as ToolCallSummary[],
      filesChanged: JSON.parse(row.files_changed_json) as string[],
      usage: JSON.parse(row.usage_json) as RunUsage,
      error: row.error_json ? JSON.parse(row.error_json) : null,
    };
  }

  private waitForRunSettlement(runId: string): Promise<RunRecord> {
    const current = this.materializeRunRecord(runId);
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled" ||
      current.status === "input_required"
    ) {
      return Promise.resolve(current);
    }
    return new Promise<RunRecord>((resolve) => {
      const list = this.runWaiters.get(runId) ?? [];
      list.push(resolve);
      this.runWaiters.set(runId, list);
    });
  }

  private notifyRunWaiters(runId: string): void {
    const waiters = this.runWaiters.get(runId);
    if (!waiters || waiters.length === 0) return;
    this.runWaiters.delete(runId);
    const rec = this.materializeRunRecord(runId);
    for (const w of waiters) {
      w(rec);
    }
  }

  private releaseUnusedPreacquiredHint(
    tenantId: string,
    hints?: StartRunHints,
  ): void {
    if (hints?.preacquiredSlot && hints.runId) {
      this.ctx.waitUntil(
        getTenantStub(this.env, tenantId)
          .releaseSlot(hints.runId)
          .catch(() => {}),
      );
    }
  }

  private runSpendLimit(runId: string): number | null {
    return this.ctx.storage.sql
      .exec<{ spend_limit_usd: number | null }>("SELECT spend_limit_usd FROM runs WHERE id = ?1", runId)
      .one().spend_limit_usd;
  }

  private runActor(runId: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ actor: string | null }>("SELECT actor FROM runs WHERE id = ?1", runId)
      .toArray()[0]?.actor ?? undefined;
  }

  private followerIdsFor(runId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM runs WHERE batched_into = ?1 AND status IN ('running', 'input_required')",
        runId,
      )
      .toArray()
      .map(({ id }) => id);
  }

  private finalizeFollowers(primaryRecord: RunRecord, followerIds: string[]): void {
    for (const fid of followerIds) {
      this.ctx.storage.sql.exec(
        `UPDATE runs
         SET status = ?1, batched_into = ?2, text = ?3, output_json = ?4, error_json = ?5, ended_at = ?6
         WHERE id = ?7`,
        primaryRecord.status,
        primaryRecord.id,
        primaryRecord.text,
        JSON.stringify(primaryRecord.output),
        primaryRecord.error ? JSON.stringify(primaryRecord.error) : null,
        primaryRecord.status === "input_required" ? null : Date.now(),
        fid,
      );
      if (primaryRecord.status !== "input_required") {
        this.logRunLifecycle(fid, `run_${primaryRecord.status}`, primaryRecord.error?.code);
      }
    }
  }

  private async expirePendingInputRow(
    inp: { id: string; run_id: string; tool_call_id: string; prompt_json: string | null },
    now: number,
  ): Promise<boolean> {
    const updatedInput = this.ctx.storage.sql.exec(
      `UPDATE inputs SET status = 'expired' WHERE id = ?1 AND status = 'pending'`,
      inp.id,
    );
    if (!updatedInput.rowsWritten) return false;

    const expired = this.ctx.storage.sql.exec(
      `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2 WHERE id = ?3 AND status IN ('input_required', 'cancelled')`,
      JSON.stringify({ code: "input_expired", message: "Pending human input timed out" }),
      now,
      inp.run_id,
    );

    await this.ensurePiEngine().abortExpiredInput(inp).catch(() => {});

    this.recordAndBroadcastEvent(inp.run_id, "input_resolved", {
      id: inp.id,
      status: "expired",
    });

    if (!expired.rowsWritten) return true;

    this.recordAndBroadcastEvent(inp.run_id, "run_failed", {
      runId: inp.run_id,
      error: { code: "input_expired", message: "Pending human input timed out" },
    });
    const failedRec = this.materializeRunRecord(inp.run_id);
    const followerIds = this.followerIdsFor(inp.run_id);
    this.finalizeFollowers(failedRec, followerIds);
    this.notifyRunWaiters(inp.run_id);
    for (const id of followerIds) this.notifyRunWaiters(id);
    return true;
  }

  // ---- Serialized Queue, Batching & Steering over PiAgentEngine ----

  private async enqueueOrRunPi(
    body: StartRunInput,
    hints?: StartRunHints,
  ): Promise<RunRecord> {
    if (this.destroying) {
      throw new ApiError(409, "agent_deleting", "Agent deletion is in progress");
    }
    const cfg = this.requireConfig();
    const prompt = String(body.prompt ?? "");
    const whileRunning = body.whileRunning === "steer" ? "steer" : "queue";
    const wait = body.wait !== undefined ? Boolean(body.wait) : true;
    // 0 = unlimited turns (stored in NOT NULL max_steps column for backwards-compatible DO SQLite schema);
    // explicit positive maxSteps still enforces a per-run turn cap (up to 1000).
    const parsedMaxSteps =
      body.maxSteps !== undefined && body.maxSteps !== null ? Number(body.maxSteps) : Number.NaN;
    const maxSteps = Number.isFinite(parsedMaxSteps)
      ? Math.max(1, Math.min(1000, Math.trunc(parsedMaxSteps)))
      : 0;
    const spendLimitUsd = body.spendLimitUsd;
    if (spendLimitUsd !== undefined && (!Number.isFinite(spendLimitUsd) || spendLimitUsd < 0)) {
      throw new ApiError(400, "invalid_spend_limit", "spendLimitUsd must be a finite non-negative number");
    }
    if (spendLimitUsd !== undefined && whileRunning === "steer") {
      throw new ApiError(400, "invalid_spend_limit", "A run with a spend limit must use whileRunning: queue");
    }
    const actor = body.actor;
    if (actor !== undefined && (typeof actor !== "string" || !actor.trim() || actor.length > 200)) {
      throw new ApiError(400, "invalid_actor", "actor must be a non-empty string of at most 200 characters");
    }
    const idempotencyKey = body.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM runs WHERE idempotency_key = ?1 LIMIT 1`,
          idempotencyKey,
        )
        .toArray();
      if (existing[0]) {
        this.releaseUnusedPreacquiredHint(cfg.tenantId, hints);
        if (wait) {
          return this.waitForRunSettlement(existing[0].id);
        }
        return this.materializeRunRecord(existing[0].id);
      }
    }

    const files = parseRunFiles(body.files);
    if (files.length > 0 && (whileRunning === "steer" || !cfg.lineage)) {
      throw new ApiError(400, "invalid_attachments", "Attachments require a queued turn and a configured repository");
    }

    // Mid-turn steer into an active running Pi turn
    const engine = this.ensurePiEngine();
    if (
      whileRunning === "steer" &&
      this.activeRunId &&
      engine.hasActiveRunningTurn() &&
      actor === engine.getActiveActor()
    ) {
      this.releaseUnusedPreacquiredHint(cfg.tenantId, hints);
      const targetRunId = this.activeRunId;
      const steerRunId = randomId("run", 8);
      const now = Date.now();

      this.ctx.storage.sql.exec(
        `INSERT INTO runs (id, idempotency_key, status, while_running, prompt, batched_into, text, usage_json, max_steps, started_at, ended_at, spend_limit_usd, actor)
         VALUES (?1, ?2, ?3, 'steer', ?4, ?5, '', ?6, ?7, ?8, ?9, ?10, ?11)`,
        steerRunId,
        idempotencyKey,
        wait ? "running" : "completed",
        prompt,
        targetRunId,
        JSON.stringify(emptyUsage()),
        maxSteps,
        now,
        wait ? null : now,
        null,
        actor ?? null,
      );
      this.logRunLifecycle(steerRunId, "run_queued");

      await engine.steerActiveRun(prompt, steerRunId, actor);

      if (!wait) {
        this.logRunLifecycle(steerRunId, "run_completed");
        return this.materializeRunRecord(steerRunId);
      }

      const settledTarget = await this.waitForRunSettlement(targetRunId);
      this.ctx.storage.sql.exec(
        `UPDATE runs SET status = ?1, text = ?2, output_json = ?3, ended_at = ?4 WHERE id = ?5`,
        settledTarget.status,
        settledTarget.text,
        JSON.stringify(settledTarget.output),
        Date.now(),
        steerRunId,
      );
      this.logRunLifecycle(steerRunId, `run_${settledTarget.status}`, settledTarget.error?.code);
      return this.materializeRunRecord(steerRunId);
    }

    // Supersede parked input_required runs unless explicitly suppressed
    if (body.supersedeInputs !== false) {
      const closedIds = await engine.supersedePendingInputRuns(actor);
      for (const closedId of closedIds) {
        const followers = this.followerIdsFor(closedId);
        if (followers.length > 0) {
          this.finalizeFollowers(this.materializeRunRecord(closedId), followers);
          for (const fid of followers) this.notifyRunWaiters(fid);
        }
      }
    }

    const runId = hints?.runId ?? randomId("run", 8);
    if (
      hints &&
      (hints.preacquiredSlot ||
        hints.prefetchedProvider !== undefined ||
        hints.prefetchedBalanceUsd !== undefined)
    ) {
      this.preRunHints.set(runId, hints);
    }
    if (body.keyScope !== undefined) {
      this.runKeyScopes.set(runId, body.keyScope);
    }

    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO runs (id, idempotency_key, status, while_running, prompt, output_schema_json, text, usage_json, max_steps, started_at, spend_limit_usd, actor)
         VALUES (?1, ?2, 'queued', ?3, ?4, ?5, '', ?6, ?7, ?8, ?9, ?10)`,
        runId,
        idempotencyKey,
        whileRunning,
        prompt,
        body.outputSchema ? JSON.stringify(body.outputSchema) : null,
        JSON.stringify(emptyUsage()),
        maxSteps,
        now,
        spendLimitUsd ?? null,
        actor ?? null,
      );
      if (files.length > 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO run_files (run_id, files_json) VALUES (?1, ?2)`,
          runId,
          JSON.stringify({ lineage: cfg.lineage, files }),
        );
      }
    });

    this.recordAndBroadcastEvent(runId, "run_queued", {
      runId,
      queueMode: cfg.queue.mode,
    });

    const generation = this.storageGeneration;
    const settlement = wait ? this.waitForRunSettlement(runId) : undefined;
    await this.scheduleNextAlarm();
    if (this.storageGeneration !== generation) {
      if (settlement) return settlement;
      throw new ApiError(409, "agent_deleting", "The agent was deleted while queuing the run");
    }
    this.ctx.waitUntil(this.drainRunQueue());
    return settlement ?? this.materializeRunRecord(runId);
  }

  private async drainRunQueue(): Promise<void> {
    if (this.destroying || !this.sqlReady || this.queueDrain || this.activeRunId) return;
    const drain = (async () => {
      while (!this.destroying && this.sqlReady) {
        const pausedRow = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM runs WHERE status = 'input_required' AND batched_into IS NULL LIMIT 1`,
          )
          .toArray();
        if (pausedRow.length > 0) break;

        const cfg = this.readConfigOrNull();
        if (!cfg) break;

        const readQueued = () =>
          this.ctx.storage.sql
            .exec<{
              id: string;
              prompt: string;
              output_schema_json: string | null;
              max_steps: number;
              spend_limit_usd: number | null;
              actor: string | null;
            }>(
              `SELECT id, prompt, output_schema_json, max_steps, spend_limit_usd, actor FROM runs WHERE status = 'queued' ORDER BY started_at ASC`,
            )
            .toArray();
        let queued = readQueued();
        if (queued.length === 0) break;

        const canBatch = (run: (typeof queued)[number]) =>
          run.spend_limit_usd === null && run.actor === null;
        if (canBatch(queued[0]!) && cfg.queue.mode === "batch" && cfg.queue.windowMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(cfg.queue.windowMs, 5_000)));
          if (this.destroying || !this.sqlReady) break;
          queued = readQueued();
          if (queued.length === 0) break;
        }

        const primary = queued[0]!;
        const firstIndividual = queued.findIndex((run) => !canBatch(run));
        const followers =
          cfg.queue.mode === "batch" && firstIndividual !== 0
            ? queued.slice(1, firstIndividual === -1 ? undefined : firstIndividual)
            : [];

        const combinedPrompt =
          followers.length > 0
            ? [primary.prompt, ...followers.map((f) => f.prompt)].join("\n\n")
            : primary.prompt;

        if (followers.length > 0) {
          for (const f of followers) {
            const followerHints = this.preRunHints.get(f.id);
            if (followerHints) {
              this.preRunHints.delete(f.id);
              this.releaseUnusedPreacquiredHint(cfg.tenantId, followerHints);
            }
            this.runKeyScopes.delete(f.id);
            this.ctx.storage.sql.exec(
              `UPDATE runs SET status = 'running', batched_into = ?1 WHERE id = ?2`,
              primary.id,
              f.id,
            );
          }
        }

        await this.executeSingleRunWithLease(
          primary.id,
          combinedPrompt,
          primary.output_schema_json
            ? (JSON.parse(primary.output_schema_json) as Record<string, unknown>)
            : null,
          primary.max_steps,
          followers.map((f) => f.id),
        );
      }
    })();
    this.queueDrain = drain;
    try {
      await drain;
    } finally {
      this.queueDrain = null;
      if (!this.destroying && this.sqlReady) {
        await this.scheduleNextAlarm().catch(() => {});
      }
    }
  }

  private async executeSingleRunWithLease(
    runId: string,
    prompt: string,
    outputSchema: Record<string, unknown> | null,
    maxSteps: number,
    batchedFollowerIds: string[],
  ): Promise<void> {
    const cfg = this.requireConfig();
    const tenantStub = getTenantStub(this.env, cfg.tenantId);

    let slotAcquired = false;
    this.activeRunId = runId;
    const hints = this.preRunHints.get(runId);
    this.preRunHints.delete(runId);
    const keyScope = this.runKeyScopes.get(runId);
    this.runKeyScopes.delete(runId);

    try {
      if (hints?.preacquiredSlot) {
        slotAcquired = true;
      } else {
        await tenantStub.acquireSlot(runId, cfg.id);
        slotAcquired = true;
      }

      const files: Array<{ lineage: string; file: RunFile }> = [];
      for (const id of [runId, ...batchedFollowerIds]) {
        const row = this.ctx.storage.sql
          .exec<{ files_json: string }>(`SELECT files_json FROM run_files WHERE run_id = ?1`, id)
          .toArray()[0];
        if (!row) continue;
        const queued = JSON.parse(row.files_json) as { lineage: string; files: RunFile[] };
        for (const file of queued.files) files.push({ lineage: queued.lineage, file });
      }

      const handedOffSlot = slotAcquired;
      slotAcquired = false; // Ownership transferred to PiAgentEngine.executeRun
      const finalRecord = await this.ensurePiEngine().executeRun({
        runId,
        prompt,
        actor: this.runActor(runId),
        files,
        outputSchema,
        maxSteps: maxSteps > 0 ? maxSteps : undefined,
        spendLimitUsd: this.runSpendLimit(runId),
        keyScope,
        hints,
        slotAcquired: handedOffSlot,
      });

      this.finalizeFollowers(finalRecord, batchedFollowerIds);
    } catch (err) {
      if (slotAcquired) {
        await tenantStub.releaseSlot(runId).catch(() => {});
      }
      const apiErr = extractApiError(err);
      const code = apiErr ? apiErr.code : "run_failed";
      const message = apiErr ? apiErr.message : err instanceof Error ? err.message : String(err);
      this.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
        JSON.stringify({ code, message }),
        Date.now(),
        runId,
      );
      this.recordAndBroadcastEvent(runId, "run_failed", { runId, error: { code, message } });
      const failedRecord = this.materializeRunRecord(runId);
      this.finalizeFollowers(failedRecord, batchedFollowerIds);
    } finally {
      if (this.activeRunId === runId) {
        this.activeRunId = null;
      }
      this.notifyRunWaiters(runId);
      for (const fid of batchedFollowerIds) {
        this.notifyRunWaiters(fid);
      }
    }
  }

  private logRunLifecycle(runId: string, event: string, code?: string): void {
    const fields = { event, runId, agentId: this.readConfigOrNull()?.id, code };
    if (event === "run_failed" && !EXPECTED_RUN_FAILURES.has(code ?? "")) {
      console.error({ message: "Agent turn failed", ...fields });
    } else {
      console.info({ message: "Agent turn lifecycle", ...fields });
    }
  }

  private watchableRuns(): Array<{ id: string; status: string; started_at: number }> {
    const sql = this.ctx.storage.sql;
    const oldest = (status: string) =>
      sql
        .exec<{ id: string; status: string; started_at: number }>(
          "SELECT id, status, started_at FROM runs WHERE status = ? AND batched_into IS NULL ORDER BY started_at LIMIT 1",
          status,
        )
        .toArray();
    const running = oldest("running");
    return oldest("input_required").length > 0 ? running : [...running, ...oldest("queued")];
  }

  private reportStalledRuns(now: number): void {
    const sql = this.ctx.storage.sql;
    for (const run of this.watchableRuns()) {
      if (now - run.started_at < RUN_STALL_AFTER_MS) continue;
      const lastEvent = sql
        .exec<{ created_at: number }>(
          "SELECT created_at FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
          run.id,
        )
        .toArray()[0];
      const lastProgressAt = lastEvent?.created_at ?? run.started_at;
      if (now - lastProgressAt < RUN_STALL_AFTER_MS) continue;
      const key = `last_stall_${run.status}`;
      const marker = `${run.id}:${lastProgressAt}`;
      const previous = sql.exec<{ v: string }>("SELECT v FROM runtime_kv WHERE k = ?", key).toArray()[0];
      if (previous?.v === marker) continue;
      console.error({
        message: "Agent turn stalled",
        event: "run_stalled",
        agentId: this.requireConfig().id,
        runId: run.id,
        status: run.status,
        ageMs: now - run.started_at,
        noProgressMs: now - lastProgressAt,
      });
      sql.exec("INSERT OR REPLACE INTO runtime_kv (k, v) VALUES (?, ?)", key, marker);
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    if (this.destroying || !this.sqlReady) return;
    const cfg = this.readConfigOrNull();
    if (!cfg) return;

    const now = Date.now();
    const candidates: number[] = [];
    if (this.watchableRuns().length > 0) {
      candidates.push((Math.floor(now / RUN_WATCH_INTERVAL_MS) + 1) * RUN_WATCH_INTERVAL_MS);
    }

    const delivery = this.ctx.storage.sql
      .exec<{ due: number | null }>("SELECT MIN(next_attempt_at) AS due FROM app_webhook_deliveries")
      .one();
    if (delivery.due !== null) candidates.push(delivery.due);

    const schedRows = this.ctx.storage.sql
      .exec<{ next_due_at: number }>(
        `SELECT MIN(next_due_at) AS next_due_at FROM schedules WHERE enabled = 1`,
      )
      .toArray();
    if (schedRows[0]?.next_due_at) {
      candidates.push(Number(schedRows[0].next_due_at));
    }

    const inputRows = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        `SELECT MIN(expires_at) AS expires_at FROM inputs WHERE status = 'pending'`,
      )
      .toArray();
    if (inputRows[0]?.expires_at) {
      candidates.push(Number(inputRows[0].expires_at));
    }

    const vmRows = this.ctx.storage.sql
      .exec<{ lease_expires_at: number }>(
        `SELECT MIN(lease_expires_at) AS lease_expires_at FROM vm_session`,
      )
      .toArray();
    if (vmRows[0]?.lease_expires_at) {
      candidates.push(Number(vmRows[0].lease_expires_at));
    }

    if (cfg.dreaming?.enabled && cfg.dreaming.idleSeconds > 0) {
      const latest = await this.ensurePiEngine().getLatestMessageMeta();
      if (latest && latest.seq > this.lastDreamedSeq) {
        candidates.push(latest.createdAt + cfg.dreaming.idleSeconds * 1000);
      }
    }

    if (
      cfg.compactOnIdle?.enabled &&
      cfg.compactOnIdle.idleSeconds > 0 &&
      !this.activeRunId &&
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM runs WHERE status = 'queued' LIMIT 1`)
        .toArray().length === 0
    ) {
      const state = await this.ensurePiEngine().getIdleCompactionState(cfg);
      const minTokens = cfg.compactOnIdle.minTokens ?? DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS;
      if (
        state &&
        state.latestSeq > this.lastIdleCompactedSeq &&
        state.activeTokens >= minTokens
      ) {
        candidates.push(state.latestAt + cfg.compactOnIdle.idleSeconds * 1000);
      }
    }

    const engine = this.ensurePiEngine();
    await engine.ensureStarted();
    if (this.destroying || !this.sqlReady) return;

    if (candidates.length > 0) {
      const earliest = Math.max(now + 250, Math.min(...candidates));
      await engine.lifecycle.jobs.push({
        id: "camelrun:periodic",
        fn: "camelrun_periodic",
        time: earliest,
        singleflight: true,
      });
    } else {
      await engine.lifecycle.jobs.cancel("camelrun:periodic");
    }
  }

  private async hasDuePeriodicWork(now: number, cfg: AgentConfig): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    if (
      sql
        .exec(`SELECT 1 FROM inputs WHERE status = 'pending' AND expires_at <= ?1 LIMIT 1`, now)
        .toArray().length > 0
    ) {
      return true;
    }
    if (
      sql.exec(`SELECT 1 FROM vm_session WHERE lease_expires_at <= ?1 LIMIT 1`, now).toArray()
        .length > 0
    ) {
      return true;
    }
    if (
      sql
        .exec(`SELECT 1 FROM schedules WHERE enabled = 1 AND next_due_at <= ?1 LIMIT 1`, now)
        .toArray().length > 0
    ) {
      return true;
    }
    if (
      sql
        .exec(`SELECT 1 FROM app_webhook_deliveries WHERE next_attempt_at <= ?1 LIMIT 1`, now)
        .toArray().length > 0
    ) {
      return true;
    }
    if (this.watchableRuns().some((run) => now - run.started_at >= RUN_STALL_AFTER_MS)) {
      return true;
    }
    if (
      !this.activeRunId &&
      sql.exec(`SELECT 1 FROM runs WHERE status = 'queued' LIMIT 1`).toArray().length > 0 &&
      sql
        .exec(`SELECT 1 FROM runs WHERE status = 'input_required' AND batched_into IS NULL LIMIT 1`)
        .toArray().length === 0
    ) {
      return true;
    }
    if (cfg.dreaming?.enabled && cfg.dreaming.idleSeconds > 0 && !this.activeRunId) {
      const latest = await this.ensurePiEngine().getLatestMessageMeta();
      if (
        latest &&
        latest.seq > this.lastDreamedSeq &&
        now - latest.createdAt >= cfg.dreaming.idleSeconds * 1000
      ) {
        return true;
      }
    }
    if (
      cfg.compactOnIdle?.enabled &&
      cfg.compactOnIdle.idleSeconds > 0 &&
      !this.activeRunId &&
      sql.exec(`SELECT 1 FROM runs WHERE status = 'queued' LIMIT 1`).toArray().length === 0
    ) {
      const state = await this.ensurePiEngine().getIdleCompactionState(cfg);
      const minTokens = cfg.compactOnIdle.minTokens ?? DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS;
      if (
        state &&
        state.latestSeq > this.lastIdleCompactedSeq &&
        state.activeTokens >= minTokens &&
        now - state.latestAt >= cfg.compactOnIdle.idleSeconds * 1000
      ) {
        return true;
      }
    }
    return false;
  }

  override async alarm(): Promise<void> {
    if (this.destroying) return;
    this.ensureSql();
    const cfg = this.readConfigOrNull();
    if (!cfg) return;

    const generation = this.storageGeneration;
    this.periodicRanInAlarm = false;

    const hasJobsTable =
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs' LIMIT 1`)
        .toArray().length > 0;
    const hadDueLifecycleJob =
      hasJobsTable &&
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM cf_agents_jobs WHERE time <= ?1 LIMIT 1`, Date.now())
        .toArray().length > 0;

    const engine = this.ensurePiEngine();
    await engine.ensureStarted();
    if (this.destroying || this.storageGeneration !== generation) return;
    await engine.lifecycle.alarm();
    if (this.destroying || this.storageGeneration !== generation) return;

    // On a lifecycle-driven alarm (such as a 30s `pi-wake` heartbeat), only run periodic
    // maintenance if periodic work is actually due. On a direct/legacy `alarm()` invocation
    // with no due lifecycle jobs, run periodic maintenance as before.
    if (
      !this.periodicRanInAlarm &&
      (!hadDueLifecycleJob || (await this.hasDuePeriodicWork(Date.now(), cfg)))
    ) {
      await this.runPeriodicTasks();
    }
  }

  async onJob(context: LifecycleJobContext): Promise<void> {
    if (this.destroying) return;
    this.ensureSql();
    if (context.job.fn === "camelrun_periodic") {
      this.periodicRanInAlarm = true;
      await this.runPeriodicTasks();
    }
  }

  private async runPeriodicTasks(): Promise<void> {
    if (this.destroying || !this.sqlReady) return;
    const cfg = this.readConfigOrNull();
    if (!cfg) return;

    const generation = this.storageGeneration;
    const stopping = () => this.destroying || this.storageGeneration !== generation;
    const now = Date.now();

    // 1. Expire stale pending human inputs
    const expiredInputs = this.ctx.storage.sql
      .exec<{
        id: string;
        run_id: string;
        tool_call_id: string;
        prompt_json: string | null;
      }>(
        `SELECT id, run_id, tool_call_id, prompt_json FROM inputs WHERE status = 'pending' AND expires_at <= ?1 ORDER BY rowid ASC`,
        now,
      )
      .toArray();
    for (const inp of expiredInputs) {
      await this.expirePendingInputRow(inp, now);
      if (stopping()) return;
    }

    this.reportStalledRuns(now);
    this.ctx.waitUntil(this.drainRunQueue());

    // 2. Clean up expired VM session leases
    const expiredVms = this.ctx.storage.sql
      .exec<{ branch: string; vm_id: string }>(
        `SELECT branch, vm_id FROM vm_session WHERE lease_expires_at <= ?1`,
        now,
      )
      .toArray();
    for (const vm of expiredVms) {
      this.ctx.storage.sql.exec(`DELETE FROM vm_session WHERE branch = ?1`, vm.branch);
      if (cfg.lineage) {
        const cfs = new CamelFsClient(this.env, cfg.tenantId);
        await cfs.stopVm(vm.vm_id, cfg.lineage).catch(() => {});
        if (stopping()) return;
      }
    }

    // 3. Fire due schedules
    const dueSchedules = this.ctx.storage.sql
      .exec<{
        id: string;
        interval_seconds: number | null;
        cron_expr: string | null;
        prompt: string;
      }>(`SELECT id, interval_seconds, cron_expr, prompt FROM schedules WHERE enabled = 1 AND next_due_at <= ?1`, now)
      .toArray();

    for (const sch of dueSchedules) {
      if (!sch.interval_seconds && !sch.cron_expr) {
        this.ctx.storage.sql.exec(`UPDATE schedules SET enabled = 0 WHERE id = ?1`, sch.id);
      } else {
        const nextDue = computeNextScheduleDue(sch.interval_seconds, sch.cron_expr, now);
        this.ctx.storage.sql.exec(
          `UPDATE schedules SET next_due_at = ?1 WHERE id = ?2`,
          nextDue,
          sch.id,
        );
      }
      try {
        await this.startRun({ prompt: sch.prompt, wait: false, supersedeInputs: false });
      } catch (error) {
        if (!stopping()) throw error;
      }
      if (stopping()) return;
    }

    // 4. Idle dreaming consolidation
    if (cfg.dreaming?.enabled && !this.activeRunId) {
      const latestMsg = await this.ensurePiEngine().getLatestMessageMeta();
      if (
        latestMsg &&
        latestMsg.seq > this.lastDreamedSeq &&
        now - latestMsg.createdAt >= cfg.dreaming.idleSeconds * 1000
      ) {
        this.lastDreamedSeq = latestMsg.seq;
        this.ctx.storage.sql.exec(
          `INSERT INTO runtime_kv (k, v) VALUES ('last_dreamed_seq', ?1)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          String(this.lastDreamedSeq),
        );
        await this.ensurePiEngine().consolidateDream().catch(() => {});
        if (stopping()) return;
      }
    }

    // 5. Warm-cache idle compaction (threshold-gated)
    if (
      cfg.compactOnIdle?.enabled &&
      cfg.compactOnIdle.idleSeconds > 0 &&
      !this.activeRunId &&
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM runs WHERE status = 'queued' LIMIT 1`)
        .toArray().length === 0
    ) {
      const state = await this.ensurePiEngine().getIdleCompactionState(cfg);
      if (
        state &&
        state.latestSeq > this.lastIdleCompactedSeq &&
        now - state.latestAt >= cfg.compactOnIdle.idleSeconds * 1000
      ) {
        this.lastIdleCompactedSeq = state.latestSeq;
        this.ctx.storage.sql.exec(
          `INSERT INTO runtime_kv (k, v) VALUES ('last_idle_compacted_seq', ?1)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          String(this.lastIdleCompactedSeq),
        );
        const minTokens = cfg.compactOnIdle.minTokens ?? DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS;
        if (state.activeTokens >= minTokens) {
          try {
            await this.ensurePiEngine().runIdleCompaction(cfg, state.latestAt);
          } catch (err) {
            console.warn("Idle alarm compaction errored", {
              agentId: cfg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (stopping()) return;
        }
      }
    }

    try {
      await this.deliverDueAppWebhooks(now, stopping);
    } finally {
      if (!stopping()) await this.scheduleNextAlarm();
    }
  }

  private async deliverDueAppWebhooks(now: number, stopping: () => boolean): Promise<void> {
    const deliveries = this.ctx.storage.sql
      .exec<{ id: string; message_json: string; attempts: number }>(
        "SELECT id, message_json, attempts FROM app_webhook_deliveries WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10",
        now,
      )
      .toArray();
    await Promise.all(
      deliveries.map(async ({ id, message_json, attempts }) => {
        try {
          await deliverWebhookMessage(this.env, JSON.parse(message_json), true);
          if (!stopping()) {
            this.ctx.storage.sql.exec("DELETE FROM app_webhook_deliveries WHERE id = ?", id);
          }
        } catch (error) {
          if (stopping()) return;
          const delivery = { id, attempt: attempts + 1, code: extractApiError(error)?.code };
          if (attempts === 2) {
            console.error({ message: "App turn webhook delivery delayed", ...delivery });
          } else {
            console.warn({ message: "App turn webhook delivery retry", ...delivery });
          }
          const delay = 1_000 * 2 ** Math.min(attempts, 8);
          this.ctx.storage.sql.exec(
            "UPDATE app_webhook_deliveries SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
            Date.now() + delay,
            id,
          );
        }
      }),
    );
  }

  private fetchStoredEvents(afterSeq: number, runIdFilter: string | null): AgentEventRecord[] {
    this.ensureSql();
    const rows = runIdFilter
      ? this.ctx.storage.sql
          .exec<{
            seq: number;
            run_id: string | null;
            type: string;
            data_json: string;
            created_at: number;
          }>(
            `SELECT * FROM events WHERE seq > ?1 AND run_id = ?2 ORDER BY seq ASC LIMIT 500`,
            afterSeq,
            runIdFilter,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<{
            seq: number;
            run_id: string | null;
            type: string;
            data_json: string;
            created_at: number;
          }>(`SELECT * FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT 500`, afterSeq)
          .toArray();

    return rows.map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      type: r.type,
      data: JSON.parse(r.data_json) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
  }

  // ---- Native Durable Object RPC Methods ----

  async initAgent(
    incoming: Partial<Omit<AgentConfig, "compactOnIdle">> & {
      id: string;
      tenantId: string;
      key: string;
      initialModel?: string;
      compactOnIdle?: Partial<CompactOnIdleConfig> | null;
    },
    initialRun?: { input: StartRunInput; hints?: StartRunHints },
  ): Promise<{ config: AgentConfig; created: boolean; run?: RunRecord }> {
    this.ensureSql();
    const existing = this.readConfigOrNull();
    const now = Date.now();
    const resolvedCompactOnIdle =
      incoming.compactOnIdle !== undefined
        ? normalizeCompactOnIdleConfig(incoming.compactOnIdle)
        : existing?.compactOnIdle;
    const merged: AgentConfig = {
      id: incoming.id,
      tenantId: incoming.tenantId,
      key: incoming.key,
      engine: "pi",
      model:
        incoming.model ??
        existing?.model ??
        incoming.initialModel ??
        this.env.DEFAULT_MODEL ??
        DEFAULT_MODEL_ID,
      keyScope:
        incoming.keyScope !== undefined
          ? (incoming.keyScope?.trim() || null)
          : (existing?.keyScope ?? null),
      instructions: incoming.instructions ?? existing?.instructions ?? "",
      definition:
        incoming.definition !== undefined
          ? incoming.definition
          : (existing?.definition ?? null),
      tools: incoming.tools ?? existing?.tools ?? [],
      mcpServers: incoming.mcpServers ?? existing?.mcpServers ?? [],
      toolIdentity: incoming.toolIdentity ?? existing?.toolIdentity,
      builtins: incoming.builtins ?? existing?.builtins ?? [],
      skills: incoming.skills !== undefined ? incoming.skills : (existing?.skills ?? []),
      queue: {
        mode: incoming.queue?.mode ?? existing?.queue.mode ?? "each",
        windowMs: incoming.queue?.windowMs ?? existing?.queue.windowMs ?? 0,
      },
      repoId:
        incoming.repoId !== undefined ? incoming.repoId : (existing?.repoId ?? null),
      lineage:
        incoming.lineage !== undefined ? incoming.lineage : (existing?.lineage ?? null),
      branch: incoming.branch ?? existing?.branch ?? "refs/heads/main",
      spendLimitUsd: incoming.spendLimitUsd ?? existing?.spendLimitUsd ?? 10,
      idleTtlSeconds: incoming.idleTtlSeconds ?? existing?.idleTtlSeconds ?? 86400,
      ...(incoming.compactThresholdTokens !== undefined
        ? typeof incoming.compactThresholdTokens === "number" &&
          Number.isFinite(incoming.compactThresholdTokens) &&
          incoming.compactThresholdTokens > 0
          ? { compactThresholdTokens: Math.floor(incoming.compactThresholdTokens) }
          : {}
        : existing?.compactThresholdTokens !== undefined
          ? { compactThresholdTokens: existing.compactThresholdTokens }
          : {}),
      ...(resolvedCompactOnIdle ? { compactOnIdle: resolvedCompactOnIdle } : {}),
      dreaming: {
        enabled: incoming.dreaming?.enabled ?? existing?.dreaming.enabled ?? false,
        idleSeconds: incoming.dreaming?.idleSeconds ?? existing?.dreaming.idleSeconds ?? 3600,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeConfig(merged);
    const indexSync =
      existing && (incoming.model !== undefined || incoming.keyScope !== undefined)
        ? this.syncIndexedModel(merged)
        : undefined;

    if (initialRun) {
      if (indexSync) {
        this.ctx.waitUntil(
          indexSync.catch((error) => {
            console.error("Agent model index update failed", { agentId: merged.id, error });
          }),
        );
      }
      const run = await this.enqueueOrRunPi(initialRun.input, initialRun.hints);
      return { config: merged, created: !existing, run };
    }

    await indexSync;
    if (existing) {
      await this.scheduleNextAlarm();
    }
    return { config: merged, created: !existing };
  }

  private async syncIndexedModel(config: AgentConfig): Promise<void> {
    await getTenantStub(this.env, config.tenantId).updateAgentModel(
      config.id,
      config.model,
      config.updatedAt,
      config.keyScope ?? null,
    );
  }

  async updateModelIfIdle(
    model: string,
    expectedModel: string,
    keyScope?: string | null,
  ): Promise<{ model: string; keyScope?: string | null; changed: boolean }> {
    this.ensureSql();
    const cfg = this.requireConfig();
    const nextScope = keyScope !== undefined ? (keyScope?.trim() || null) : (cfg.keyScope ?? null);
    if (cfg.model === model && (cfg.keyScope ?? null) === nextScope) {
      await this.syncIndexedModel(cfg);
      return { model, ...(nextScope ? { keyScope: nextScope } : {}), changed: false };
    }
    if (cfg.model !== expectedModel) {
      throw new ApiError(409, "model_changed", "The agent model changed");
    }
    const pending =
      this.ctx.storage.sql
        .exec("SELECT 1 FROM runs WHERE status IN ('queued', 'running', 'input_required') LIMIT 1")
        .toArray().length > 0;
    if (this.activeRunId || pending) {
      throw new ApiError(409, "agent_busy", "The agent has work in progress");
    }
    const updated: AgentConfig = { ...cfg, model, keyScope: nextScope, updatedAt: Date.now() };
    this.writeConfig(updated);
    await this.ensurePiEngine().syncModelChange(updated);
    await this.syncIndexedModel(updated);
    return { model, ...(nextScope ? { keyScope: nextScope } : {}), changed: true };
  }

  updateSpendLimitIfIdle(
    scope: { tenantId: string; agentId: string },
    spendLimitUsd: number,
    expectedSpendLimitUsd: number,
  ) {
    if (
      ![spendLimitUsd, expectedSpendLimitUsd].every(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    ) {
      throw new ApiError(
        400,
        "invalid_spend_limit",
        "Spend limits must be finite non-negative numbers",
      );
    }
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('config', 'runs')",
      )
      .toArray();
    if (tables.length !== 2) {
      throw new ApiError(404, "agent_not_initialized", "Agent is not initialized");
    }
    const cfg = this.requireConfig();
    if (!scope?.tenantId || !scope.agentId || cfg.tenantId !== scope.tenantId || cfg.id !== scope.agentId) {
      throw new ApiError(404, "agent_not_found", "Agent not found");
    }
    if (!Number.isFinite(cfg.spendLimitUsd) || cfg.spendLimitUsd < 0) {
      throw new ApiError(503, "agent_config_invalid", "Agent spend limit is unavailable");
    }
    if (cfg.spendLimitUsd === spendLimitUsd) return { spendLimitUsd, changed: false };
    if (cfg.spendLimitUsd !== expectedSpendLimitUsd) {
      throw new ApiError(409, "spend_limit_changed", "The agent spend limit changed");
    }
    const pending =
      this.ctx.storage.sql
        .exec("SELECT 1 FROM runs WHERE status IN ('queued', 'running', 'input_required') LIMIT 1")
        .toArray().length > 0;
    if (this.destroying || this.activeRunId || this.queueDrain || this.inputResumeWork || pending) {
      throw new ApiError(409, "agent_busy", "The agent has work in progress");
    }
    this.writeConfig({ ...cfg, spendLimitUsd });
    return { spendLimitUsd, changed: true };
  }

  async seedFork(payload: {
    config: AgentConfig;
    piEntries: EntryRecord[];
    entryMeta?: Array<{
      entryId: number;
      runId: string | null;
      meta?: Record<string, unknown>;
      repoCommit?: string | null;
    }>;
  }): Promise<{ seeded: true }> {
    this.ensureSql();
    const cfg: AgentConfig = { ...payload.config, engine: "pi" };
    this.writeConfig(cfg);
    await this.ensurePiEngine().seedForkEntries(cfg, payload.piEntries, payload.entryMeta);
    return { seeded: true };
  }

  async getOpsRunStats(fromMs: number, untilMs: number): Promise<{
    responses: number;
    endUsers: number;
    lastAt: number | null;
  }> {
    this.ensureSql();
    const row = this.ctx.storage.sql
      .exec<{ responses: number; end_users: number; last_at: number | null }>(
        `SELECT COUNT(*) AS responses,
                COUNT(DISTINCT CASE WHEN actor IS NOT NULL AND actor != '' THEN actor END) AS end_users,
                MAX(started_at) AS last_at
         FROM runs
         WHERE started_at >= ?1
           AND started_at < ?2
           AND (
             status IN ('completed', 'input_required')
             OR (
               status != 'cancelled'
               AND (
                 COALESCE(CAST(json_extract(usage_json, '$.inputTokens') AS INTEGER), 0) > 0
                 OR COALESCE(CAST(json_extract(usage_json, '$.outputTokens') AS INTEGER), 0) > 0
               )
             )
           )`,
        fromMs,
        untilMs,
      )
      .one();
    return {
      responses: Number(row.responses ?? 0),
      endUsers: Number(row.end_users ?? 0),
      lastAt: row.last_at !== null ? Number(row.last_at) : null,
    };
  }

  async getState(): Promise<
    AgentConfig & {
      status: "running" | "idle";
      activeRunId: string | null;
      messageCount: number;
      lastRun: RunRecord | null;
    }
  > {
    this.ensureSql();
    const cfg = this.requireConfig();
    const latestRunRow = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`)
      .toArray()[0];
    const messageCount = (await this.ensurePiEngine().getMessageCount()) ?? 0;
    return {
      id: cfg.id,
      key: cfg.key,
      tenantId: cfg.tenantId,
      engine: "pi",
      model: cfg.model,
      keyScope: cfg.keyScope ?? null,
      instructions: cfg.instructions,
      definition: cfg.definition,
      tools: cfg.tools,
      mcpServers: cfg.mcpServers,
      toolIdentity: cfg.toolIdentity,
      builtins: cfg.builtins,
      skills: cfg.skills ?? [],
      queue: cfg.queue,
      repoId: cfg.repoId,
      lineage: cfg.lineage,
      branch: cfg.branch,
      spendLimitUsd: cfg.spendLimitUsd,
      idleTtlSeconds: cfg.idleTtlSeconds,
      ...(cfg.compactThresholdTokens !== undefined
        ? { compactThresholdTokens: cfg.compactThresholdTokens }
        : {}),
      ...(cfg.compactOnIdle !== undefined ? { compactOnIdle: cfg.compactOnIdle } : {}),
      dreaming: cfg.dreaming,
      status: this.activeRunId ? "running" : "idle",
      activeRunId: this.activeRunId,
      messageCount,
      lastRun: latestRunRow ? this.materializeRunRecord(latestRunRow.id) : null,
      createdAt: cfg.createdAt,
      updatedAt: cfg.updatedAt,
    };
  }

  async startRun(body: StartRunInput, hints?: StartRunHints): Promise<RunRecord> {
    this.ensureSql();
    if (typeof body.prompt !== "string") {
      throw new ApiError(400, "invalid_request", "`prompt` must be a string");
    }
    return this.enqueueOrRunPi(body, hints);
  }

  async appendPassiveNote(text: string, meta?: Record<string, unknown>): Promise<{ ok: true }> {
    this.ensureSql();
    this.requireConfig();
    await this.ensurePiEngine().appendPassiveNote(text, meta);
    return { ok: true };
  }

  async getRun(runId: string, byIdempotencyKey = false): Promise<RunRecord> {
    this.ensureSql();
    if (byIdempotencyKey) {
      const row = this.ctx.storage.sql
        .exec<{ id: string }>("SELECT id FROM runs WHERE idempotency_key = ?1", runId)
        .toArray()[0];
      if (!row) throw new ApiError(404, "run_not_found", "No run for that idempotency key");
      return this.materializeRunRecord(row.id);
    }
    return this.materializeRunRecord(runId);
  }

  async getRunState(): Promise<{ cursor: number; activeRunId: string | null; runs: RunRecord[] }> {
    this.ensureSql();
    const sql = this.ctx.storage.sql;
    const open = sql
      .exec<{ id: string }>(
        "SELECT id FROM runs WHERE status IN ('queued', 'running', 'input_required') ORDER BY started_at, rowid",
      )
      .toArray();
    const recent = sql
      .exec<{ id: string }>(
        `SELECT id FROM runs WHERE status IN ('completed', 'failed', 'cancelled')
         ORDER BY started_at DESC, rowid DESC LIMIT 64`,
      )
      .toArray();
    const cursor = sql.exec<{ seq: number }>("SELECT coalesce(max(seq), 0) AS seq FROM events").one().seq;
    return {
      cursor,
      activeRunId: this.activeRunId,
      runs: [...recent.reverse(), ...open].map(({ id }) => this.materializeRunRecord(id)),
    };
  }

  async getRunsWithPendingInputs(): Promise<RunRecord[]> {
    this.ensureSql();
    const rows = this.ctx.storage.sql
      .exec<{ run_id: string }>(
        "SELECT DISTINCT run_id FROM inputs WHERE status = 'pending' AND expires_at > ?1",
        Date.now(),
      )
      .toArray();
    return rows.map((row) => this.materializeRunRecord(row.run_id));
  }

  async abortRuns(body?: { keepQueued?: boolean; supersedeInputs?: boolean }): Promise<{
    aborted: true;
    cancelledRunIds: string[];
  }> {
    this.ensureSql();
    const res = await this.ensurePiEngine().abortRuns(body);
    for (const runId of res.cancelledRunIds) {
      const followers = this.followerIdsFor(runId);
      if (followers.length > 0) {
        this.finalizeFollowers(this.materializeRunRecord(runId), followers);
        for (const fid of followers) this.notifyRunWaiters(fid);
      }
    }
    if (body?.keepQueued && !this.destroying) {
      this.ctx.waitUntil(this.drainRunQueue());
      void this.scheduleNextAlarm();
    }
    return res;
  }

  async getEvents(opts?: {
    after?: number | "latest";
    runId?: string | null;
  }): Promise<{ events: AgentEventRecord[]; nextAfter: number }> {
    if (opts?.after === "latest") {
      this.ensureSql();
      const row = opts.runId
        ? this.ctx.storage.sql
            .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?1", opts.runId)
            .one()
        : this.ctx.storage.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").one();
      return { events: [], nextAfter: row.seq ?? 0 };
    }
    const after = Math.max(0, Number(opts?.after ?? 0));
    const events = this.fetchStoredEvents(after, opts?.runId ?? null);
    const nextAfter = events.length > 0 ? events[events.length - 1]!.seq : after;
    return { events, nextAfter };
  }

  async getHistory(opts?: { after?: number; before?: number; limit?: number }): Promise<{
    messages: Array<{
      seq: number;
      runId: string | null;
      role: StoredMessage["role"];
      content: Record<string, unknown>;
      tokensEst: number;
      createdAt: number;
    }>;
    compaction: { id: string; upToSeq: number; summary: string } | null;
    nextAfter: number;
    nextBefore?: number | null;
  }> {
    this.ensureSql();
    const piHistory = await this.ensurePiEngine().getHistory(opts);
    if (piHistory !== null) return piHistory;
    const after = Math.max(0, Number(opts?.after ?? 0));
    return {
      messages: [],
      compaction: null,
      nextAfter: after,
      ...(opts?.before !== undefined ? { nextBefore: null } : {}),
    };
  }

  async compactHistory(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ summary: string; upToSeq: number; compactedCount: number }> {
    this.ensureSql();
    return this.ensurePiEngine().compactHistory(body);
  }

  async resetContext(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ ok: true; upToSeq: number; summary: string }> {
    this.ensureSql();
    return this.ensurePiEngine().resetContext(body);
  }

  async forkAgent(body?: {
    key?: string;
    atSeq?: number;
    atCommit?: string;
    forkRepo?: boolean;
    instructions?: string;
    toolIdentity?: AgentConfig["toolIdentity"];
  }): Promise<{
    id: string;
    key: string;
    agentToken: string;
    repoId: string | null;
    lineage: string | null;
    branch: string;
    commit: string;
    forkedFrom: { agentId: string; atSeq: number; atCommit?: string };
  }> {
    this.ensureSql();
    const sourceCfg = this.requireConfig();
    const tenantStub = getTenantStub(this.env, sourceCfg.tenantId);

    const activeRow = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM runs WHERE status IN ('running', 'input_required') ORDER BY started_at DESC LIMIT 1",
      )
      .toArray()[0];
    const activeRunId = this.activeRunId ?? activeRow?.id ?? null;

    const {
      entries: piEntries,
      targetSeq,
      entryMeta,
      repoCommit,
    } = await this.ensurePiEngine().exportEntriesUpTo(body?.atSeq, activeRunId);

    const explicitAtCommit = body?.atCommit?.trim() || undefined;
    const resolvedAtCommit =
      explicitAtCommit ?? (body?.atSeq !== undefined ? (repoCommit ?? undefined) : undefined);

    const newKey =
      body?.key?.trim() || `${sourceCfg.key}-fork-${randomId("f", 3).slice(2)}`;
    const existingWithKey = await tenantStub.resolveAgent(newKey);
    if (existingWithKey) {
      throw new ApiError(409, "conflict", `Agent with key '${newKey}' already exists`);
    }

    let forkedRepoId: string | null = null;
    let forkedLineage: string | null = null;
    let forkedBranch = sourceCfg.branch || "refs/heads/main";
    let forkedCommit = "";

    const shouldForkRepo = body?.forkRepo !== false;
    const sourceLineage = shouldForkRepo
      ? (sourceCfg.lineage ??
        (sourceCfg.repoId ? (await tenantStub.getRepo(sourceCfg.repoId)).lineage : null))
      : null;

    if (sourceLineage) {
      const cfs = new CamelFsClient(this.env, sourceCfg.tenantId);
      const forkedLin = await cfs.forkLineage(sourceLineage, {
        sourceRef: sourceCfg.branch,
        ...(resolvedAtCommit ? { atCommit: resolvedAtCommit } : {}),
      });
      const repoRec = await tenantStub.createRepo({
        name: `${newKey}-repo`,
        existingLineage: forkedLin.lineage,
        defaultRef: forkedLin.ref,
        commit: forkedLin.commit,
      });
      forkedRepoId = repoRec.repoId;
      forkedLineage = repoRec.lineage;
      forkedBranch = repoRec.defaultRef;
      forkedCommit = repoRec.commit;
    }

    const newAgentId = randomId("agt", 8);
    const { token: agentToken, tokenHash } = await mintAgentToken(
      sourceCfg.tenantId,
      newAgentId,
    );
    const sealedToken = await sealSecret(agentToken, this.env.VAULT_SECRET);
    const now = Date.now();

    await tenantStub.upsertAgentIndex({
      id: newAgentId,
      key: newKey,
      tokenHash,
      sealedToken,
      model: sourceCfg.model,
      repoId: forkedRepoId,
      branch: forkedBranch,
      definitionSlug: sourceCfg.definition ?? null,
    });

    const forkedConfig: AgentConfig = {
      ...sourceCfg,
      id: newAgentId,
      key: newKey,
      engine: "pi",
      ...(body?.instructions !== undefined ? { instructions: body.instructions } : {}),
      ...(body?.toolIdentity !== undefined ? { toolIdentity: body.toolIdentity } : {}),
      repoId: forkedRepoId,
      lineage: forkedLineage,
      branch: forkedBranch,
      createdAt: now,
      updatedAt: now,
    };

    await getAgentStub(this.env, newAgentId).seedFork({
      config: forkedConfig,
      piEntries,
      entryMeta,
    });

    return {
      id: newAgentId,
      key: newKey,
      agentToken,
      repoId: forkedRepoId,
      lineage: forkedLineage,
      branch: forkedBranch,
      commit: forkedCommit,
      forkedFrom: {
        agentId: sourceCfg.id,
        atSeq: targetSeq,
        ...(resolvedAtCommit ? { atCommit: resolvedAtCommit } : {}),
      },
    };
  }

  async respondToInput(
    inputId: string,
    body?: { approved?: boolean; answer?: unknown; wait?: boolean; actor?: string },
    trustedResponder = false,
  ): Promise<RunRecord> {
    if (this.destroying) {
      throw new ApiError(409, "agent_deleting", "Agent deletion is in progress");
    }
    this.ensureSql();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        run_id: string;
        tool_call_id: string;
        kind: "approval" | "question";
        status: string;
        prompt_json: string | null;
        pending_turn_json: string | null;
        expires_at: number;
      }>(
        `SELECT id, run_id, tool_call_id, kind, status, prompt_json, pending_turn_json, expires_at FROM inputs WHERE id = ?1 LIMIT 1`,
        inputId,
      )
      .toArray();

    const inp = rows[0];
    if (!inp) {
      throw new ApiError(404, "input_not_found", `Input '${inputId}' not found`);
    }
    const actor = this.runActor(inp.run_id);
    if (actor && (!trustedResponder || body?.actor !== actor)) {
      throw new ApiError(403, "input_actor_mismatch", "Only the run's actor can respond to its inputs");
    }
    if (inp.status !== "pending") {
      throw new ApiError(
        409,
        "input_already_resolved",
        `Input '${inputId}' is already ${inp.status}`,
      );
    }
    if (inp.expires_at <= Date.now()) {
      await this.expirePendingInputRow(inp, Date.now());
      if (!this.destroying) {
        void this.scheduleNextAlarm();
        this.ctx.waitUntil(this.drainRunQueue());
      }
      throw new ApiError(410, "input_expired", `Input '${inputId}' has expired`);
    }

    const work = this.ensurePiEngine().respondToInput(inp, body, trustedResponder);
    this.inputResumeWork = work;
    try {
      return await work;
    } finally {
      if (this.inputResumeWork === work) {
        this.inputResumeWork = null;
      }
    }
  }

  async listSchedules(): Promise<{ schedules: ScheduleRecord[] }> {
    this.ensureSql();
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        interval_seconds: number | null;
        cron_expr: string | null;
        prompt: string;
        next_due_at: number;
        enabled: number;
      }>(`SELECT * FROM schedules ORDER BY next_due_at ASC`)
      .toArray();
    const schedules: ScheduleRecord[] = rows.map((r) => ({
      id: r.id,
      intervalSeconds: r.interval_seconds,
      cronExpr: r.cron_expr,
      prompt: r.prompt,
      nextDueAt: r.next_due_at,
      enabled: Boolean(r.enabled),
    }));
    return { schedules };
  }

  async createSchedule(body: {
    id?: string;
    intervalSeconds?: number;
    cron?: string;
    cronExpr?: string;
    runAt?: string | number;
    enabled?: boolean;
    prompt: string;
  }): Promise<ScheduleRecord> {
    this.ensureSql();
    if (!body.prompt?.trim()) {
      throw new ApiError(400, "invalid_request", "`prompt` is required for schedule");
    }
    const intervalSeconds =
      typeof body.intervalSeconds === "number" && body.intervalSeconds > 0
        ? Math.floor(body.intervalSeconds)
        : null;
    const cronExpr = (body.cronExpr ?? body.cron)?.trim() || null;
    let parsedRunAt: number | null = null;
    if (body.runAt !== undefined && body.runAt !== null && body.runAt !== "") {
      const ms = typeof body.runAt === "number" ? body.runAt : Date.parse(body.runAt);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new ApiError(400, "invalid_request", "`runAt` must be a valid ISO timestamp or Unix ms");
      }
      parsedRunAt = Math.floor(ms);
    }
    if (!intervalSeconds && !cronExpr && parsedRunAt === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "Provide `intervalSeconds`, `cron`/`cronExpr`, or `runAt`",
      );
    }

    const id = body.id?.trim() || randomId("sch", 6);
    const enabled = body.enabled !== false;
    const nextDueAt =
      parsedRunAt !== null && !intervalSeconds && !cronExpr
        ? parsedRunAt
        : computeNextScheduleDue(intervalSeconds, cronExpr, Date.now());
    this.ctx.storage.sql.exec(
      `INSERT INTO schedules (id, interval_seconds, cron_expr, prompt, next_due_at, enabled)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         interval_seconds = excluded.interval_seconds,
         cron_expr = excluded.cron_expr,
         prompt = excluded.prompt,
         next_due_at = excluded.next_due_at,
         enabled = excluded.enabled`,
      id,
      intervalSeconds,
      cronExpr,
      body.prompt.trim(),
      nextDueAt,
      enabled ? 1 : 0,
    );
    await this.scheduleNextAlarm();
    return {
      id,
      intervalSeconds,
      cronExpr,
      prompt: body.prompt.trim(),
      nextDueAt,
      enabled,
    };
  }

  async deleteSchedule(scheduleId: string): Promise<{ deleted: true }> {
    this.ensureSql();
    this.ctx.storage.sql.exec(`DELETE FROM schedules WHERE id = ?1`, scheduleId);
    await this.scheduleNextAlarm();
    return { deleted: true };
  }

  async runWorkflow(body: {
    code: string;
    idempotencyKey?: string;
    wait?: boolean;
  }): Promise<WorkflowExecutionSummary> {
    this.ensureSql();
    if (typeof body.code !== "string" || !body.code.trim()) {
      throw new ApiError(400, "invalid_request", "`code` is required");
    }
    const cfg = this.requireConfig();
    const workflowId = randomId("wf", 8);
    const scope = body.idempotencyKey?.trim()
      ? `wf:${body.idempotencyKey.trim()}`
      : `wf:${workflowId}`;
    const engine = this.ensurePiEngine();

    return executeAgentWorkflow(
      workflowId,
      scope,
      body.code,
      {
        getCachedStep: (s, k) => {
          const rows = this.ctx.storage.sql
            .exec<{ result_json: string }>(
              `SELECT result_json FROM step_cache WHERE scope = ?1 AND step_key = ?2 LIMIT 1`,
              s,
              k,
            )
            .toArray();
          if (!rows[0]) return undefined;
          return JSON.parse(rows[0].result_json) as unknown;
        },
        putCachedStep: (s, k, v) => {
          this.ctx.storage.sql.exec(
            `INSERT INTO step_cache (scope, step_key, result_json, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, step_key) DO UPDATE SET result_json = excluded.result_json`,
            s,
            k,
            JSON.stringify(v ?? null),
            Date.now(),
          );
        },
        runAgentStep: async (prompt, opts) => {
          const run = await this.enqueueOrRunPi({
            prompt,
            wait: true,
            outputSchema:
              opts?.outputSchema && typeof opts.outputSchema === "object"
                ? (opts.outputSchema as Record<string, unknown>)
                : null,
          });
          return {
            id: run.id,
            status: run.status,
            text: run.text,
            output: run.output,
          };
        },
        runBashStep: (cmd, opts) => engine.executeBashStep(cmd, opts),
        runCommitStep: (msg) => engine.executeCommitStep(msg),
        runToolStep: (name, args) => engine.executeRegisteredTool(name, args, randomId("wftool", 6)),
      },
      {
        env: this.env,
        instanceName: `${cfg.id}:wf:${workflowId}`,
      },
    );
  }

  async triggerDream(): Promise<{
    ok: boolean;
    path: string;
    commit: string;
    summary: string;
  }> {
    this.ensureSql();
    return this.ensurePiEngine().consolidateDream();
  }

  async destroyAgent(): Promise<{ deleted: true }> {
    if (this.destroying) {
      throw new ApiError(409, "agent_deleting", "Agent deletion is in progress");
    }
    this.destroying = true;
    try {
      await this.abortRuns();
      await Promise.all([this.queueDrain, this.inputResumeWork]);
      const cfg = this.readConfigOrNull();
      if (cfg) {
        for (const hint of this.preRunHints.values()) {
          this.releaseUnusedPreacquiredHint(cfg.tenantId, hint);
        }
      }
      const vms = this.ctx.storage.sql
        .exec<{ vm_id: string }>(`SELECT vm_id FROM vm_session`)
        .toArray();
      if (cfg?.lineage) {
        const cfs = new CamelFsClient(this.env, cfg.tenantId);
        for (const v of vms) {
          await cfs.stopVm(v.vm_id, cfg.lineage).catch(() => {});
        }
      }
      if (this.piEngine) {
        await this.piEngine.dispose().catch(() => {});
        this.piEngine = null;
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.storageGeneration++;
      this.cachedConfig = null;
      this.preRunHints.clear();
      this.runKeyScopes.clear();
      this.lastDreamedSeq = 0;
      this.lastIdleCompactedSeq = 0;
      this.sqlReady = false;
      return { deleted: true };
    } finally {
      this.destroying = false;
    }
  }

  // ---- Streaming & WebSocket Upgrade Endpoints ONLY ----

  override async fetch(request: Request): Promise<Response> {
    try {
      this.ensureSql();
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "GET" && path === "/ws") {
        const upgrade = request.headers.get("upgrade") ?? request.headers.get("Upgrade") ?? "";
        if (upgrade.toLowerCase() !== "websocket") {
          throw new ApiError(426, "upgrade_required", "Expected WebSocket Upgrade header");
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
          tools: [],
        } satisfies WsAttachment);
        return new Response(null, { status: 101, webSocket: client });
      }

      if (method === "GET" && path === "/events") {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
        const runIdFilter = url.searchParams.get("runId") || null;

        const enc = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();

        const formatSse = (ev: AgentEventRecord) =>
          enc.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

        const isTerminalEvent = (t: string) =>
          t === "run_completed" ||
          t === "run_failed" ||
          t === "run_cancelled" ||
          t === "input_required";

        const initialEvents = this.fetchStoredEvents(after, runIdFilter);
        let closed = false;

        const closeStream = (listener?: (ev: AgentEventRecord) => void) => {
          if (closed) return;
          closed = true;
          if (listener) this.sseListeners.delete(listener);
          void writer.close().catch(() => {});
        };

        let shouldCloseImmediately = false;
        if (runIdFilter) {
          try {
            const r = this.readRunRowOrThrow(runIdFilter);
            if (
              r.status === "completed" ||
              r.status === "failed" ||
              r.status === "cancelled" ||
              r.status === "input_required"
            ) {
              shouldCloseImmediately = true;
            }
          } catch {
            // Run might not exist yet
          }
        } else if (!this.activeRunId && url.searchParams.get("follow") !== "1") {
          shouldCloseImmediately = true;
        }

        const liveListener = (ev: AgentEventRecord) => {
          if (closed) return;
          if (runIdFilter && ev.runId !== runIdFilter) return;
          void writer.write(formatSse(ev)).catch(() => closeStream(liveListener));
          if (runIdFilter && isTerminalEvent(ev.type)) {
            closeStream(liveListener);
          }
        };

        if (!shouldCloseImmediately) {
          this.sseListeners.add(liveListener);
          request.signal.addEventListener("abort", () => closeStream(liveListener), {
            once: true,
          });
        }

        void (async () => {
          for (const ev of initialEvents) {
            await writer.write(formatSse(ev));
          }
          if (shouldCloseImmediately) {
            closeStream(liveListener);
          }
        })();

        return new Response(readable, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      throw new ApiError(404, "not_found", `Unknown AgentDO stream route: ${method} ${path}`);
    } catch (err) {
      return toApiErrorResponse(err);
    }
  }
}

function matchCronField(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("*/")) {
      const step = Number.parseInt(trimmed.slice(2), 10);
      if (step > 0 && value % step === 0) return true;
    } else if (trimmed.includes("-")) {
      const [loStr, hiStr] = trimmed.split("-");
      const lo = Number.parseInt(loStr ?? "0", 10);
      const hi = Number.parseInt(hiStr ?? "0", 10);
      if (value >= lo && value <= hi) return true;
    } else {
      if (Number.parseInt(trimmed, 10) === value) return true;
    }
  }
  return false;
}

function computeNextScheduleDue(
  intervalSeconds: number | null,
  cronExpr: string | null,
  fromMs: number,
): number {
  if (intervalSeconds && intervalSeconds > 0) {
    return fromMs + intervalSeconds * 1000;
  }
  if (cronExpr) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length === 5) {
      const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
      const baseMinuteMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
      for (let i = 0; i < 10_080; i++) {
        const candidateMs = baseMinuteMs + i * 60_000;
        const d = new Date(candidateMs);
        if (
          matchCronField(minF, d.getUTCMinutes()) &&
          matchCronField(hourF, d.getUTCHours()) &&
          matchCronField(domF, d.getUTCDate()) &&
          matchCronField(monF, d.getUTCMonth() + 1) &&
          matchCronField(dowF, d.getUTCDay())
        ) {
          return candidateMs;
        }
      }
    }
  }
  return fromMs + 60_000;
}
