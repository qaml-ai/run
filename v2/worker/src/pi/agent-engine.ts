import { Buffer } from "node:buffer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  AssistantEntry,
  CompactionEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  type AgentChange,
  type Conversation,
  type ConversationWatch,
  type EntryId,
  type EntryRecord,
  type Extension,
  type JsonObject,
  type LiveState,
  type Registry,
  type SubmissionId,
  type TaskId,
  type ToolExecutionResult,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { CodemodeGlobal } from "@earendil-works/pi-durable/codemode";
import {
  createToolSearchExtension,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import type { DurableObject } from "cloudflare:workers";
import { CamelFsClient, normalizeRepoPath } from "../camelfs.ts";
import { randomId } from "../crypto.ts";
import { imageHeader } from "../lib/image-header.ts";
import { consumeInfraCredit } from "../ops-metadata.ts";
import { isImageAttachment, verifyRunFiles } from "../run-files.ts";
import { toolImageKey } from "../tool-images.ts";
import { getSkillStore, type SkillRecord } from "../skills.ts";
import { getTenantStub, platformCreditReserve } from "../tenant-do.ts";
import {
  ApiError,
  DEFAULT_COMPACT_ON_IDLE_KEEP_RECENT_TOKENS,
  emptyUsage,
  extractApiError,
  type AgentConfig,
  type AgentEventRecord,
  type Env,
  type RunFile,
  type RunRecord,
  type RunUsage,
  type StartRunHints,
  type StoredMessage,
  type StoredRunFile,
  type ToolCallSummary,
} from "../types.ts";
import { createCamelFsExecutionEnv, type TmpScratchEntry } from "./camelfs-env.ts";
import { createCamelRunCodemodeExtension } from "./codemode-extension.ts";
import {
  createCamelRunBillingExtension,
  createCamelRunBrowserExtension,
  createCamelRunCodingExtension,
  createCamelRunDelegateExtension,
  createCamelRunHumanExtension,
  createCamelRunMcpExtension,
  createCamelRunRepoExtension,
  createCamelRunSkillsExtension,
  HumanInputSignal,
  type BillingUsageEvent,
  type HumanInputRequiredEvent,
} from "./extensions.ts";
import { ensurePiHistoryIndexes, readPiHistoryPage } from "./history.ts";
import {
  CamelRunUserEntry,
  copyPiEntriesToConversation,
  importLegacyTranscriptToPi,
  isUserContentEntry,
  unwrapCompactionSummary,
  wrapCompactionSummary,
  type ImportedEntryMeta,
  type LegacyCompactionRow,
  type MappedHistoryResult,
} from "./migrate.ts";
import {
  buildPiModels,
  calculatePiCostUsd,
  completePiModel,
  createProviderRequestExtension,
  getModelContextWindow,
  parsePiModelRef,
  PI_COMPACT_RESERVE_TOKENS,
  resolveTenantByokProvider,
} from "./models.ts";

const BG = BACKGROUND_CONTEXT;

export interface PiPendingInputMetadata {
  engine?: "pi";
  piTaskId: number;
  piConversationId: number;
  toolName: string;
  mcpInput?: Record<string, unknown>;
}

export interface PiAgentHost {
  readonly durableObject: DurableObject<Env>;
  readonly env: Env;
  readonly ctx: DurableObjectState;
  getConfig(): AgentConfig;
  readConfigOrNull(): AgentConfig | null;
  isDestroying(): boolean;
  ensureAgentRepository(): Promise<{ repoId: string; lineage: string; branch: string }>;
  hasWebSocketTool(name: string): boolean;
  invokeWebSocketTool(name: string, args: Record<string, unknown>, callId: string): Promise<unknown>;
  recordAndBroadcastEvent(
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): AgentEventRecord;
  broadcastEphemeralEvent(
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): AgentEventRecord;
  hasEventSubscribers(): boolean;
  enqueueAppWebhook(tenantId: string, eventType: string, payload: Record<string, unknown>): void;
  scheduleNextAlarm(): Promise<void>;
  materializeRunRecord(runId: string): RunRecord;
  waitForRunSettlement(runId: string): Promise<RunRecord>;
  notifyRunWaiters(runId: string): void;
  setActiveRunId(runId: string | null): void;
  getActiveRunId(): string | null;
  onRunSettled?(runId: string): void;
  runWorkflow?(body: { code: string; idempotencyKey?: string }): Promise<unknown>;
}

interface PiRunProgress {
  lastEntryId: number;
  lastMessageEntryId: number | null;
  generationTaskId: number | null;
  generationAttempt: number;
  generationTextStart: number;
  attemptTextStart: number;
  partialTextLen: number;
  openToolCalls: string[];
}

type RunProgressEvent =
  | { type: "text_delta"; data: { delta: string } }
  | { type: "tool_call_start" | "tool_call_end"; data: Record<string, unknown> };

interface ActiveRunTracker {
  runId: string;
  actor?: string;
  outputSchema: Record<string, unknown> | null;
  spendLimitUsd: number | null;
  usage: RunUsage;
  filesChanged: Set<string>;
  toolCalls: ToolCallSummary[];
  openToolCalls: Set<string>;
  seenToolEnds: Set<string>;
  baselineEntryId: number | null;
  submissionId: SubmissionId | null;
  submissionFinished: boolean;
  answerEntryId: EntryId | null;
  nextRunEntryId: EntryId | null;
  lastEntryId: number | null;
  lastMessageEntryId: number | null;
  generationTaskId: number | null;
  generationAttempt: number;
  generationTextStart: number;
  attemptTextStart: number;
  partialTextLen: number;
  lastRepoCommit: string | null;
  accumulatedText: string;
  slotAcquired: boolean;
  settling: boolean;
  settled: boolean;
  pausedForInput: boolean;
  spendLimitError: { code: "spend_limit_exceeded"; message: string } | null;
  aborted: boolean;
  recovered: boolean;
  watchStarting: boolean;
  watchHandle: ConversationWatch | null;
  watchProcessing: Promise<void> | null;
  watchPromise: Promise<void> | null;
}

const RUN_ENTRY_PAGE_SIZE = 8;

type ActiveRunRow = {
  id: string;
  status: string;
  actor: string | null;
  output_schema_json: string | null;
  spend_limit_usd: number | null;
  baseline_entry_id: number | null;
  pi_progress_json: string | null;
};

const FILES_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "list_files",
  "grep_files",
  "delete_file",
  "repo_checkpoint",
  "repo_restore",
  "repo_history",
  "repo_diff",
  "view_image",
]);

function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function extractAssistantToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((b): b is ToolCall => b.type === "toolCall");
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function tryParseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

function formatCustomToolOutput(result: unknown): ToolExecutionResult {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const rawBlocks = (result as { content: Array<Record<string, unknown>> }).content.filter(
      (b): b is Record<string, unknown> => Boolean(b && typeof b === "object"),
    );
    const blocks: Array<TextContent | ImageContent> = [];
    const imageDims: string[] = [];
    for (const b of rawBlocks) {
      if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
        const hdr = imageHeader(Buffer.from(b.data, "base64"));
        if (hdr) imageDims.push(`[image ${hdr.width}×${hdr.height}]`);
        blocks.push({ type: "image", mimeType: b.mimeType, data: b.data });
      } else {
        blocks.push({
          type: "text",
          text: typeof b.text === "string" ? b.text : JSON.stringify(b),
        });
      }
    }
    if (imageDims.length > 0) {
      const firstTextIdx = blocks.findIndex((b) => b.type === "text");
      if (firstTextIdx >= 0) {
        const prev = blocks[firstTextIdx] as TextContent;
        blocks[firstTextIdx] = { type: "text", text: `${prev.text}\n${imageDims.join("\n")}` };
      } else {
        blocks.unshift({ type: "text", text: imageDims.join("\n") });
      }
    }
    return { output: blocks };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return {
    output: [{ type: "text", text }],
    structuredOutput: JSON.parse(JSON.stringify(result ?? null)),
  };
}

function isPiPendingInputMetadata(value: unknown): value is PiPendingInputMetadata {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { piTaskId?: unknown }).piTaskId === "number",
  );
}

/**
 * Pi durable agent engine owned lazily by `AgentDO`.
 *
 * Composes `Lifecycle` (`agents/lifecycle`) + `PiHarness` (`agents/harness/pi`) over
 * `openPiSessionStore(ctx.storage, { prefix: "pi_" })`.
 */
export class PiAgentEngine {
  readonly lifecycle: Lifecycle<Env>;
  readonly harness: PiHarness;

  private readonly host: PiAgentHost;
  private readonly registry: Registry = createRegistry();
  private currentModels: Awaited<ReturnType<typeof buildPiModels>> | null = null;
  private activeTracker: ActiveRunTracker | null = null;
  private startPromise: Promise<void> | null = null;
  private rootReady = false;
  private historyIndexesReady = false;
  private installedCustomFingerprint = "";
  private installedMcpFingerprint = "";
  private lastAppliedAgentConfigFp = "";
  private readonly tmpEntries = new Map<string, TmpScratchEntry>();
  private resolvedSkillsCache: { key: string; skills: SkillRecord[]; expiresAt: number } | null = null;

  constructor(host: PiAgentHost) {
    this.host = host;
    this.lifecycle = new Lifecycle<Env>(host.durableObject);

    this.harness = new PiHarness({
      harness: async ({ storage, onWake }) => {
        const cfg = this.host.getConfig();
        if (!this.currentModels) {
          this.currentModels = await buildPiModels({
            env: this.host.env,
            tenantId: cfg.tenantId,
            keyScope: cfg.keyScope ?? null,
            rawModel: cfg.model,
            getOutputSchema: () => this.getOrRehydrateActiveTracker()?.outputSchema ?? null,
          });
        }

        await this.ensureExtensionsInstalled(cfg);

        return Harness.open(
          storage,
          {
            models: () => this.currentModels!,
            registry: this.registry,
            onWake,
            settings: () => {
              const cur = this.host.readConfigOrNull();
              const override = cur?.compactThresholdTokens;
              if (typeof override === "number" && Number.isFinite(override) && override > 0) {
                const modelStr = cur?.model ?? cfg.model;
                const ref = parsePiModelRef(modelStr, this.host.env);
                const realContextWindow =
                  this.currentModels?.getModel(ref.provider, ref.modelId)?.contextWindow ??
                  getModelContextWindow(modelStr);
                const minThreshold = 8_000;
                const maxThreshold = Math.max(minThreshold, Math.floor(realContextWindow * 0.8));
                const effectiveThreshold = Math.min(
                  maxThreshold,
                  Math.max(minThreshold, Math.floor(override)),
                );
                return {
                  compaction: {
                    enabled: true,
                    reserveTokens: Math.max(
                      PI_COMPACT_RESERVE_TOKENS,
                      realContextWindow - effectiveThreshold,
                    ),
                    keepRecentTokens: Math.min(12_000, Math.floor(effectiveThreshold / 2)),
                    backgroundTokens: Math.min(8_000, Math.floor(effectiveThreshold * 0.2)),
                  },
                  progress: { partialIntervalMs: 250, outputIntervalMs: 250, persistWithinMs: 30_000 },
                  afterFailedRun: "keep",
                  restartLimit: 25,
                };
              }
              return {
                compaction: { enabled: true },
                progress: { partialIntervalMs: 250, outputIntervalMs: 250, persistWithinMs: 30_000 },
                afterFailedRun: "keep",
                restartLimit: 25,
              };
            },
            env: async () => this.buildExecutionEnv(),
          },
          BG,
        );
      },
      defaults: {},
    });

    this.lifecycle.use(this.harness);
  }

  async ensureStarted(): Promise<void> {
    if (!this.lifecycle.isStarted()) {
      this.startPromise ??= this.lifecycle.start().catch((err) => {
        this.startPromise = null;
        throw err;
      });
      await this.startPromise;
    }
    // If the DO was evicted mid-run and woken by `pi-wake`, rehydrate the active run tracker
    // so post-eviction billing, spend limits, outputSchema, and terminal settlement continue.
    const tracker = this.activeTracker ?? this.getOrRehydrateActiveTracker();
    if (tracker?.recovered && !tracker.settled && !tracker.pausedForInput) {
      this.trackSubmissionSettlement(tracker, this.host.hasEventSubscribers());
    }
  }

  private async getRootConversation(): Promise<Conversation | undefined> {
    const pi = await this.harness.pi();
    return pi.conversation(ROOT_CONVERSATION_ID, BG);
  }

  getActiveActor(): string | undefined {
    if (this.activeTracker && !this.activeTracker.settled && !this.activeTracker.pausedForInput) {
      return this.activeTracker.actor;
    }
    return undefined;
  }

  hasActiveRunningTurn(): boolean {
    return Boolean(
      this.activeTracker && !this.activeTracker.settled && !this.activeTracker.pausedForInput,
    );
  }

  getActiveRunOverlay(runId: string): {
    text: string;
    toolCalls: ToolCallSummary[];
    filesChanged: string[];
    usage: RunUsage;
  } | null {
    const tracker = this.activeTracker;
    if (!tracker || tracker.settled || tracker.runId !== runId) return null;
    return {
      text: tracker.accumulatedText,
      toolCalls: [...tracker.toolCalls],
      filesChanged: [...tracker.filesChanged],
      usage: { ...tracker.usage },
    };
  }

  async steerActiveRun(prompt: string, steerRunId: string, actor?: string): Promise<void> {
    await this.ensureStarted();
    await this.harness.session(ROOT_SESSION).steer(prompt, {
      operationId: steerRunId,
      entry: {
        kind: CamelRunUserEntry.kind,
        data: { runId: steerRunId, ...(actor ? { actor } : {}) },
      },
    });
  }

  private getOrRehydrateActiveTracker(): ActiveRunTracker | null {
    if (this.activeTracker && !this.activeTracker.settled) {
      return this.activeTracker;
    }
    if (!this.host.readConfigOrNull()) return null;

    const row = this.host.ctx.storage.sql.exec<ActiveRunRow>(
      `SELECT id, status, actor, output_schema_json, spend_limit_usd, baseline_entry_id, pi_progress_json
       FROM runs
       WHERE status IN ('running', 'input_required') AND batched_into IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    ).toArray()[0];
    if (!row) return null;

    const isRunning = row.status === "running";
    const tracker = this.rehydrateTracker(row);
    this.activeTracker = tracker;
    if (isRunning) {
      this.host.setActiveRunId(row.id);
      if (this.lifecycle.isStarted()) {
        this.trackSubmissionSettlement(tracker, this.host.hasEventSubscribers());
      }
    }
    return tracker;
  }

  private rehydrateTracker(row: ActiveRunRow): ActiveRunTracker {
    const existingRec = this.host.materializeRunRecord(row.id);
    // Rolls forward from a checkpoint written with the boundary-aware tracker. Older
    // runs may already have progress in their row that cannot be attributed safely.
    const progress = row.baseline_entry_id !== null && row.pi_progress_json !== null
      ? JSON.parse(row.pi_progress_json) as PiRunProgress
      : null;
    const isRunning = row.status === "running";
    const toolCalls = progress ? existingRec.toolCalls : [];
    return {
      runId: row.id,
      actor: row.actor ?? undefined,
      outputSchema: row.output_schema_json ? JSON.parse(row.output_schema_json) : null,
      spendLimitUsd: row.spend_limit_usd ?? null,
      usage: { ...existingRec.usage },
      filesChanged: new Set(existingRec.filesChanged),
      toolCalls,
      openToolCalls: new Set(progress?.openToolCalls),
      seenToolEnds: new Set(toolCalls.map((t) => t.id)),
      baselineEntryId: row.baseline_entry_id,
      submissionId: null,
      submissionFinished: false,
      answerEntryId: null,
      nextRunEntryId: null,
      lastEntryId: progress?.lastEntryId ?? row.baseline_entry_id,
      lastMessageEntryId: progress?.lastMessageEntryId ?? null,
      generationTaskId: progress?.generationTaskId ?? null,
      generationAttempt: progress?.generationAttempt ?? -1,
      generationTextStart: progress?.generationTextStart ?? 0,
      attemptTextStart: progress?.attemptTextStart ?? 0,
      partialTextLen: progress?.partialTextLen ?? 0,
      lastRepoCommit: null,
      accumulatedText: progress ? existingRec.text : "",
      slotAcquired: isRunning,
      settling: false,
      settled: false,
      pausedForInput: !isRunning,
      spendLimitError: null,
      aborted: false,
      recovered: true,
      watchStarting: false,
      watchHandle: null,
      watchProcessing: null,
      watchPromise: null,
    };
  }

  async dispose(): Promise<void> {
    if (this.activeTracker?.watchHandle) {
      await this.activeTracker.watchHandle.stop().catch(() => {});
      this.activeTracker.watchHandle = null;
    }
    this.activeTracker = null;
    this.rootReady = false;
    this.lastAppliedAgentConfigFp = "";
    this.installedMcpFingerprint = "";
    this.installedCustomFingerprint = "";
    this.tmpEntries.clear();
    await this.harness.dispose().catch(() => {});
    await this.lifecycle.dispose().catch(() => {});
  }

  private async getResolvedSkills(): Promise<SkillRecord[]> {
    const cfg = this.host.getConfig();
    const selectors = cfg.skills ?? [];
    if (selectors.length === 0) return [];
    const key = `${cfg.tenantId}:${selectors.join(",")}`;
    const now = Date.now();
    if (this.resolvedSkillsCache && this.resolvedSkillsCache.key === key && this.resolvedSkillsCache.expiresAt > now) {
      return this.resolvedSkillsCache.skills;
    }
    const skills = await getSkillStore(this.host.env).resolveSkills(cfg.tenantId, selectors);
    this.resolvedSkillsCache = { key, skills, expiresAt: now + 30_000 };
    return skills;
  }

  private updateRepoCommit(tenantId: string, repoId: string, commit: string): Promise<void> {
    if (commit && this.activeTracker && !this.activeTracker.settled) {
      this.activeTracker.lastRepoCommit = commit;
    }
    return getTenantStub(this.host.env, tenantId)
      .updateRepoCommit(repoId, commit)
      .then(() => undefined)
      .catch(() => undefined);
  }

  private buildExecutionEnv() {
    const cfg = this.host.getConfig();
    const sql = this.host.ctx.storage.sql;
    return createCamelFsExecutionEnv({
      env: this.host.env,
      tenantId: cfg.tenantId,
      agentId: cfg.id,
      tmpEntries: this.tmpEntries,
      ensureRepo: () => this.host.ensureAgentRepository(),
      getResolvedSkills: () => this.getResolvedSkills(),
      onFilesChanged: (files) => this.recordFilesChanged(files),
      onRepoCommit: (repoId, commit) => this.updateRepoCommit(cfg.tenantId, repoId, commit),
      getVmSession: (branch) => {
        const row = sql
          .exec<{ vm_id: string; lease_expires_at: number }>(
            `SELECT vm_id, lease_expires_at FROM vm_session WHERE branch = ?1 LIMIT 1`,
            branch,
          )
          .toArray()[0];
        return row ? { vmId: row.vm_id, leaseExpiresAt: row.lease_expires_at } : null;
      },
      saveVmSession: (branch, vmId, leaseExpiresAt) => {
        sql.exec(
          `INSERT INTO vm_session (branch, vm_id, lease_expires_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(branch) DO UPDATE SET vm_id = excluded.vm_id, lease_expires_at = excluded.lease_expires_at`,
          branch,
          vmId,
          leaseExpiresAt,
        );
        void this.host.scheduleNextAlarm();
      },
      clearVmSession: (branch, vmId) => {
        sql.exec("DELETE FROM vm_session WHERE branch = ?1 AND vm_id = ?2", branch, vmId);
      },
      onVmBillableMs: (billableMs) => this.recordVmBillableMs(billableMs),
    });
  }

  private recordFilesChanged(files: string[]): void {
    const tracker = this.getOrRehydrateActiveTracker();
    if (!tracker) return;
    for (const f of files) tracker.filesChanged.add(f);
    this.persistTrackerProgress(tracker);
  }

  private recordVmBillableMs(billableMs: number): void {
    const tracker = this.getOrRehydrateActiveTracker();
    if (!tracker || !billableMs) return;
    const cfg = this.host.getConfig();
    tracker.usage.vmMs += billableMs;
    const addedCost = calculatePiCostUsd(cfg.model, 0, 0, billableMs, 0);
    tracker.usage.costUsd = Number((tracker.usage.costUsd + addedCost).toFixed(8));
    this.persistTrackerProgress(tracker);
  }

  private serializeStreamProgress(tracker: ActiveRunTracker): string | null {
    if (tracker.lastEntryId === null) return null;
    return JSON.stringify({
      lastEntryId: tracker.lastEntryId,
      lastMessageEntryId: tracker.lastMessageEntryId,
      generationTaskId: tracker.generationTaskId,
      generationAttempt: tracker.generationAttempt,
      generationTextStart: tracker.generationTextStart,
      attemptTextStart: tracker.attemptTextStart,
      partialTextLen: tracker.partialTextLen,
      openToolCalls: [...tracker.openToolCalls],
    } satisfies PiRunProgress);
  }

  private persistTrackerProgress(tracker: ActiveRunTracker): void {
    this.host.ctx.storage.sql.exec(
      `UPDATE runs
       SET text = ?1, tool_calls_json = ?2, files_changed_json = ?3, usage_json = ?4,
           baseline_entry_id = ?5, pi_progress_json = ?6
       WHERE id = ?7 AND status IN ('running', 'input_required')`,
      tracker.accumulatedText,
      JSON.stringify(tracker.toolCalls),
      JSON.stringify([...tracker.filesChanged]),
      JSON.stringify(tracker.usage),
      tracker.baselineEntryId,
      this.serializeStreamProgress(tracker),
      tracker.runId,
    );
  }

  private persistStreamProgress(tracker: ActiveRunTracker, events: RunProgressEvent[]): boolean {
    const text = events.find((event) => event.type === "text_delta")?.data.delta ?? "";
    const toolsChanged = events.some((event) => event.type === "tool_call_end");
    const updated = this.host.ctx.storage.sql.exec(
      `UPDATE runs
       SET pi_progress_json = ?1,
           text = CASE WHEN ?2 = '' THEN text ELSE text || ?2 END,
           tool_calls_json = COALESCE(?3, tool_calls_json)
       WHERE id = ?4 AND status IN ('running', 'input_required')`,
      this.serializeStreamProgress(tracker),
      text,
      toolsChanged ? JSON.stringify(tracker.toolCalls) : null,
      tracker.runId,
    );
    return updated.rowsWritten > 0;
  }

  private buildCustomAndWebExtension(cfg: AgentConfig): Extension {
    const tools: ToolRegistration[] = [];

    tools.push(
      defineTool({
        name: "web_fetch",
        description: "Fetch an HTTP/HTTPS URL and return its response text.",
        parameters: obj(
          {
            url: str({ description: "HTTP or HTTPS URL to fetch" }),
            maxChars: opt(num({ description: "Maximum characters to return (default 16000)" })),
          },
          { open: true },
        ),
        async execute(args, _api, context) {
          const maxChars = typeof args.maxChars === "number" ? args.maxChars : 16_000;
          const res = await fetch(args.url, {
            headers: { "User-Agent": "CamelRun-Worker/2.0" },
            signal: context.abortSignal,
          });
          const text = await res.text();
          return {
            output: [
              {
                type: "text",
                text: JSON.stringify({
                  url: args.url,
                  status: res.status,
                  contentType: res.headers.get("content-type") ?? "text/plain",
                  body: text.slice(0, maxChars),
                }),
              },
            ],
          };
        },
      }) as ToolRegistration,
    );

    tools.push(
      defineTool({
        name: "web_search",
        description: "Search the web for current information.",
        parameters: obj(
          {
            query: str({ description: "Search query" }),
            limit: opt(num({ description: "Maximum number of results (default 5)" })),
          },
          { open: true },
        ),
        async execute(args, _api, context) {
          const results: Array<{ title: string; url: string; snippet: string }> = [];
          try {
            const ddg = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`;
            const res = await fetch(ddg, { signal: context.abortSignal });
            if (res.ok) {
              const json = (await res.json()) as {
                AbstractText?: string;
                AbstractURL?: string;
                RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
              };
              if (json.AbstractText) {
                results.push({
                  title: args.query,
                  url: json.AbstractURL || "",
                  snippet: json.AbstractText,
                });
              }
              for (const t of (json.RelatedTopics ?? []).slice(0, Number(args.limit ?? 5))) {
                if (t.Text) {
                  results.push({
                    title: t.Text.slice(0, 80),
                    url: t.FirstURL || "",
                    snippet: t.Text,
                  });
                }
              }
            }
          } catch {
            // Offline fallback
          }
          return {
            output: [{ type: "text", text: JSON.stringify({ query: args.query, results }) }],
          };
        },
      }) as ToolRegistration,
    );

    const host = this.host;
    const getActiveRunId = () => this.getOrRehydrateActiveTracker()?.runId;
    for (const custom of cfg.tools ?? []) {
      const spec = custom;
      tools.push(
        defineTool({
          name: spec.name,
          description: spec.description || `Custom tool ${spec.name}`,
          parameters: (spec.parameters && typeof spec.parameters === "object"
            ? spec.parameters
            : { type: "object", properties: {} }) as Record<string, unknown>,
          ...(spec.deferred ? { deferred: true as const } : {}),
          async execute(args, api, context) {
            const curCfg = host.getConfig();
            const runId = getActiveRunId() ?? `run_${api.conversationId}`;
            let result: unknown;
            if (spec.url) {
              const res = await fetch(spec.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CamelRun-Agent": curCfg.id,
                  "X-CamelRun-Run": runId,
                  ...(spec.headers ?? {}),
                },
                body: JSON.stringify({
                  callId: api.callId,
                  agentId: curCfg.id,
                  runId,
                  name: spec.name,
                  args: args ?? {},
                }),
                signal: context.abortSignal,
              });
              const text = await res.text();
              if (!res.ok) {
                throw new Error(`Webhook tool '${spec.name}' returned HTTP ${res.status}: ${text}`);
              }
              try {
                result = JSON.parse(text);
              } catch {
                result = text;
              }
            } else if (host.hasWebSocketTool(spec.name)) {
              result = await host.invokeWebSocketTool(
                spec.name,
                (args ?? {}) as Record<string, unknown>,
                api.callId,
              );
            } else {
              throw new Error(
                `Tool '${spec.name}' has no webhook url and no connected WebSocket client registered it`,
              );
            }

            return formatCustomToolOutput(result);
          },
        }) as unknown as ToolRegistration,
      );
    }

    tools.push(
      defineTool({
        name: "run_workflow",
        description:
          "Execute a deterministic replay-cached workflow script with `wf.agent`, `wf.parallel`, `wf.bash`, `wf.commit`, `wf.sleep`, `wf.tool`, `wf.step`.",
        parameters: obj(
          {
            code: str({ description: "JavaScript workflow body" }),
            idempotencyKey: opt(str({ description: "Optional idempotency scope key" })),
          },
          { open: true },
        ),
        async execute(args) {
          if (!host.runWorkflow) {
            throw new Error("Workflow execution is not configured on this agent");
          }
          const res = await host.runWorkflow({
            code: args.code,
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
          });
          return {
            output: [{ type: "text", text: JSON.stringify(res ?? null) }],
            structuredOutput: JSON.parse(JSON.stringify(res ?? null)),
          };
        },
      }) as unknown as ToolRegistration,
    );

    return defineExtension({
      name: "camelrun-custom-and-web",
      tools,
    });
  }

  private buildCodemodeFsGlobals(): CodemodeGlobal[] {
    const host = this.host;
    const onFilesChanged = (files: string[]) => this.recordFilesChanged(files);
    const onRepoCommit = (tenantId: string, repoId: string, commit: string) =>
      this.updateRepoCommit(tenantId, repoId, commit);
    return [
      {
        name: "fs.readFile",
        spread: true,
        async execute(rawArgs) {
          const tuple = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
          const filePath = normalizeRepoPath(String(tuple[0] ?? ""));
          const cfg = host.getConfig();
          const { lineage, branch } = await host.ensureAgentRepository();
          const cfs = new CamelFsClient(host.env, cfg.tenantId);
          const res = await cfs.read(lineage, { at: branch, path: filePath });
          return res.content ?? res.base64 ?? "";
        },
      },
      {
        name: "fs.writeFile",
        spread: true,
        async execute(rawArgs) {
          const tuple = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
          const filePath = normalizeRepoPath(String(tuple[0] ?? ""));
          const content = String(tuple[1] ?? "");
          const cfg = host.getConfig();
          const { repoId, lineage, branch } = await host.ensureAgentRepository();
          const cfs = new CamelFsClient(host.env, cfg.tenantId);
          const out = await cfs.write(lineage, {
            ref: branch,
            holder: cfg.id,
            author: `agent:${cfg.id}`,
            message: `codemode write ${filePath}`,
            puts: [{ path: filePath, content, mode: 0o644 }],
          });
          onFilesChanged(out.changed);
          await onRepoCommit(cfg.tenantId, repoId, out.commit);
          return JSON.parse(JSON.stringify(out));
        },
      },
      {
        name: "fs.readdir",
        spread: true,
        async execute(rawArgs) {
          const tuple = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
          const dirPath = String(tuple[0] ?? "");
          const cfg = host.getConfig();
          const { lineage, branch } = await host.ensureAgentRepository();
          const cfs = new CamelFsClient(host.env, cfg.tenantId);
          const out = await cfs.ls(lineage, { at: branch, path: dirPath, recursive: false });
          return JSON.parse(JSON.stringify(out.entries));
        },
      },
    ];
  }

  private async ensureExtensionsInstalled(cfg: AgentConfig): Promise<void> {
    const snap = this.registry.snapshot();

    if (!snap.extension("camelrun-provider-request")) {
      this.registry.install(
        createProviderRequestExtension({
          getOutputSchema: () => this.getOrRehydrateActiveTracker()?.outputSchema ?? null,
        }),
      );
    }

    if (!snap.extension("camelrun-billing")) {
      this.registry.install(
        createCamelRunBillingExtension({
          getSpendLimitUsd: () => {
            const limit = this.getOrRehydrateActiveTracker()?.spendLimitUsd;
            return limit === null || limit === undefined ? undefined : limit;
          },
          getSpentUsd: () => this.getOrRehydrateActiveTracker()?.usage.costUsd ?? 0,
          onSpendLimitExceeded: (ev) => {
            const tracker = this.getOrRehydrateActiveTracker();
            if (tracker) {
              tracker.spendLimitError = {
                code: "spend_limit_exceeded",
                message: `Run spend limit exceeded ($${ev.spentUsd.toFixed(6)} >= $${ev.spendLimitUsd.toFixed(6)})`,
              };
            }
          },
          abortTask: async (taskId) => {
            const pi = await this.harness.pi();
            await pi.abortTask(taskId as TaskId, BG).catch(() => {});
          },
          onUsageRecorded: (ev) => this.handleBillingUsage(ev),
        }),
      );
    }

    if (!snap.extension("camelrun-human")) {
      this.registry.install(
        createCamelRunHumanExtension({
          requiresApproval: (toolName) => {
            const curCfg = this.host.readConfigOrNull();
            const custom = curCfg?.tools?.find((t) => t.name === toolName);
            return Boolean(custom?.requiresApproval);
          },
          onInputRequired: (ev) => this.handleInputRequired(ev),
          onInputCancelled: (inputId) => this.handleInputCancelled(inputId),
        }),
      );
    }

    if (!snap.extension("coding")) {
      this.registry.install(
        createCamelRunCodingExtension({
          images: this.host.env.IMAGES,
          readAtCommit: async (rawPath, at) => {
            const curCfg = this.host.getConfig();
            const { lineage } = await this.host.ensureAgentRepository();
            const cfs = new CamelFsClient(this.host.env, curCfg.tenantId);
            const cleanPath = normalizeRepoPath(rawPath);
            const res = await cfs.read(lineage, { at, path: cleanPath });
            return res.content ?? res.base64 ?? "";
          },
        }),
      );
    }

    if (!snap.extension("camelrun-repo")) {
      this.registry.install(
        createCamelRunRepoExtension({
          env: this.host.env,
          tenantId: cfg.tenantId,
          agentId: cfg.id,
          ensureRepo: () => this.host.ensureAgentRepository(),
          onFilesChanged: (files) => this.recordFilesChanged(files),
          onRepoCommit: (repoId, commit) => this.updateRepoCommit(cfg.tenantId, repoId, commit),
        }),
      );
    }

    if (!snap.extension("camelrun-skills")) {
      this.registry.install(
        createCamelRunSkillsExtension({
          env: this.host.env,
          tenantId: cfg.tenantId,
          getResolvedSkills: () => this.getResolvedSkills(),
        }),
      );
    }

    if (!snap.extension("camelrun-browser")) {
      this.registry.install(
        createCamelRunBrowserExtension({
          env: this.host.env,
          tenantId: cfg.tenantId,
          agentId: cfg.id,
          ensureRepo: () => this.host.ensureAgentRepository(),
          onFilesChanged: (files) => this.recordFilesChanged(files),
          onRepoCommit: (repoId, commit) => this.updateRepoCommit(cfg.tenantId, repoId, commit),
        }),
      );
    }

    if (!snap.extension("camelrun-delegate")) {
      const sql = this.host.ctx.storage.sql;
      this.registry.install(
        createCamelRunDelegateExtension({
          env: this.host.env,
          getConfig: () => this.host.getConfig(),
          getRunId: () => this.getOrRehydrateActiveTracker()?.runId ?? "",
          recordChildAgent: (entry) => {
            sql.exec(
              `INSERT INTO children (id, child_agent_id, child_agent_key, parent_run_id, status, result_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)
               ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_json = excluded.result_json`,
              entry.id,
              entry.childAgentId,
              entry.childAgentKey,
              entry.parentRunId,
              entry.status,
              JSON.stringify(entry.result ?? null),
            );
          },
          getChildAgent: (idOrAgentId) => {
            const r = sql
              .exec<{
                id: string;
                child_agent_id: string;
                child_agent_key: string;
                status: string;
                result_json: string | null;
              }>(
                `SELECT * FROM children WHERE id = ?1 OR child_agent_id = ?1 OR child_agent_key = ?1 LIMIT 1`,
                idOrAgentId,
              )
              .toArray()[0];
            return r
              ? {
                  id: r.id,
                  childAgentId: r.child_agent_id,
                  childAgentKey: r.child_agent_key,
                  status: r.status,
                  result: r.result_json ? JSON.parse(r.result_json) : null,
                }
              : null;
          },
        }),
      );
    }

    if (this.host.env.CODEMODE_SANDBOX && !snap.extension("pi.codemode") && !snap.extension("codemode")) {
      this.registry.install(
        createCamelRunCodemodeExtension({
          env: this.host.env,
          instanceName: () => `${this.host.getConfig().id}:root`,
          models: false,
          globals: this.buildCodemodeFsGlobals(),
        }),
      );
    }

    if (!snap.extension("tool-search")) {
      this.registry.install(createToolSearchExtension());
    }

    const customFp = JSON.stringify(cfg.tools ?? []);
    if (customFp !== this.installedCustomFingerprint || !snap.extension("camelrun-custom-and-web")) {
      this.registry.install(this.buildCustomAndWebExtension(cfg));
      this.installedCustomFingerprint = customFp;
    }

    // Install placeholder MCP extension without eager network discovery (callers like camel-bots
    // upsert agents before activating signed MCP ACLs). Real MCP discovery happens lazily in
    // `ensureMcpExtensionReady()` right before `executeRun` or `respondToInput`.
    if (!snap.extension("camelrun-mcp")) {
      this.registry.install(defineExtension({ name: "camelrun-mcp", tools: [] }));
    }
  }

  private async ensureMcpExtensionReady(cfg: AgentConfig): Promise<void> {
    const deferByDefault = true;
    const mcpFp = JSON.stringify({ servers: cfg.mcpServers ?? [], deferByDefault });
    if (mcpFp === this.installedMcpFingerprint) return;
    if ((cfg.mcpServers ?? []).length > 0) {
      let hadDiscoveryError = false;
      const mcpExt = await createCamelRunMcpExtension({
        env: this.host.env,
        agent: cfg,
        getRunId: () => this.getOrRehydrateActiveTracker()?.runId ?? "",
        getActor: () => this.getOrRehydrateActiveTracker()?.actor,
        onInputRequired: (ev) => this.handleInputRequired(ev),
        onDiscoveryError: () => {
          hadDiscoveryError = true;
        },
        deferByDefault,
      });
      const existingToolsCount =
        this.registry.snapshot().extension("camelrun-mcp")?.tools?.length ?? 0;
      if (!hadDiscoveryError || (mcpExt.tools?.length ?? 0) > 0 || existingToolsCount === 0) {
        this.registry.install(mcpExt);
      }
      if (!hadDiscoveryError) {
        this.installedMcpFingerprint = mcpFp;
      }
    } else {
      this.registry.install(defineExtension({ name: "camelrun-mcp", tools: [] }));
      this.installedMcpFingerprint = mcpFp;
    }
  }

  private buildAgentChange(
    cfg: AgentConfig,
    maxTurns?: number,
  ): AgentChange {
    const builtins = new Set(cfg.builtins ?? []);
    const customNames = new Set((cfg.tools ?? []).map((t) => t.name));
    const hasSkills = builtins.has("skills") || (cfg.skills?.length ?? 0) > 0;
    const hasMcp = (cfg.mcpServers?.length ?? 0) > 0;

    const registeredTools = this.registry.snapshot().tools();
    const baseEnabled = registeredTools.filter(
      ({ extension, tool: { name } }) =>
        customNames.has(name) ||
        (extension.name === "camelrun-mcp" && hasMcp) ||
        (FILES_TOOL_NAMES.has(name) && builtins.has("files")) ||
        (name === "render_image" && builtins.has("images")) ||
        (name === "bash" && builtins.has("bash")) ||
        (name === "codemode" && builtins.has("codemode") && Boolean(this.host.env.CODEMODE_SANDBOX)) ||
        (name === "ask_human" && builtins.has("human")) ||
        ((name === "read_skill" || name === "search_skills") && hasSkills) ||
        (extension.name === "camelrun-browser" && builtins.has("browser")) ||
        (extension.name === "camelrun-delegate" && builtins.has("delegate")) ||
        (name === "web_fetch" && builtins.has("web_fetch")) ||
        (name === "web_search" && builtins.has("web_search")) ||
        (name === "run_workflow" && builtins.has("workflows")),
    );
    const hasDeferredTools = baseEnabled.some(({ tool }) => tool.deferred === true);
    const enableToolSearch = builtins.has("tool_search") || hasDeferredTools;
    const toolSearchEntry = enableToolSearch
      ? registeredTools.find(({ tool: { name } }) => name === TOOL_SEARCH_TOOL_NAME)
      : undefined;
    const enabledTools = [
      ...baseEnabled.map(({ tool }) => tool),
      ...(toolSearchEntry ? [toolSearchEntry.tool] : []),
    ];

    const modelRef = parsePiModelRef(cfg.model, this.host.env);
    const resolvedModel = this.currentModels?.getModel(modelRef.provider, modelRef.modelId);
    const thinkingLevel: AgentChange["thinkingLevel"] =
      modelRef.provider === "azure" && resolvedModel?.reasoning ? "low" : null;

    return {
      model: modelRef,
      thinkingLevel,
      instructions: cfg.instructions ? cfg.instructions : null,
      tools: enabledTools,
      // Default to unlimited turns (null clears any previously persisted maxTurns on existing agents);
      // explicit per-run maxSteps still applies when provided, and spendLimit guards runaway cost.
      maxTurns: maxTurns ?? null,
    };
  }

  private agentChangeFingerprint(change: AgentChange): string {
    const toolNames = Array.isArray(change.tools) ? change.tools.map((t) => t.name) : change.tools;
    return JSON.stringify({
      model: change.model,
      thinkingLevel: change.thinkingLevel,
      instructions: change.instructions,
      tools: toolNames,
      maxTurns: change.maxTurns,
    });
  }

  private async handleBillingUsage(ev: BillingUsageEvent): Promise<void> {
    const tracker = this.getOrRehydrateActiveTracker();
    if (!tracker) {
      if (ev.kind !== "compaction") return;
      if (ev.inputTokens <= 0 && ev.outputTokens <= 0 && ev.costUsd <= 0) return;
      const cfg = this.host.readConfigOrNull();
      if (!cfg) return;
      const { isByok } = await resolveTenantByokProvider(
        this.host.env,
        cfg.tenantId,
        cfg.model,
        undefined,
        cfg.keyScope ?? null,
      );
      const costUsd = isByok ? 0 : ev.costUsd;
      await getTenantStub(this.host.env, cfg.tenantId)
        .settleUsage({
          refId: `compaction:${cfg.id}:${ev.taskId}`,
          model: cfg.model,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          vmMs: 0,
          costUsd,
          note: `Compaction ${cfg.key} (${cfg.id})`,
          agentId: cfg.id,
          ...(isByok ? { byok: true } : {}),
        })
        .catch(() => {});
      return;
    }
    const cfg = this.host.getConfig();
    tracker.usage.inputTokens += ev.inputTokens;
    tracker.usage.outputTokens += ev.outputTokens;
    tracker.usage.cacheReadTokens = (tracker.usage.cacheReadTokens ?? 0) + ev.cacheReadTokens;
    tracker.usage.costUsd = Number((tracker.usage.costUsd + ev.costUsd).toFixed(8));

    if (tracker.actor) {
      this.host.ctx.storage.transactionSync(() => {
        this.persistTrackerProgress(tracker);
        this.host.enqueueAppWebhook(cfg.tenantId, "usage.recorded", {
          agentId: cfg.id,
          runId: tracker.runId,
          actor: tracker.actor,
          context: cfg.toolIdentity?.context,
          model: cfg.model,
          kind: ev.kind ?? "response",
          input: ev.inputTokens,
          output: ev.outputTokens,
          cacheRead: ev.cacheReadTokens,
          cost: { usd: ev.costUsd, source: "catalog" },
        });
      });
      void this.host.scheduleNextAlarm();
    } else {
      this.persistTrackerProgress(tracker);
    }
  }

  private async handleInputRequired(ev: HumanInputRequiredEvent): Promise<void> {
    const tracker = this.activeTracker;
    const runId = tracker?.runId ?? this.findMostRecentActiveRunId();
    if (!runId) return;

    const meta: PiPendingInputMetadata = {
      engine: "pi",
      piTaskId: ev.taskId,
      piConversationId: ev.conversationId,
      toolName: ev.toolName,
      ...(ev.mcpInput ? { mcpInput: ev.mcpInput } : {}),
    };

    const inserted = this.host.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO inputs (id, run_id, tool_call_id, kind, prompt_json, status, answer_json, pending_turn_json, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, ?6, ?7)`,
      ev.inputId,
      runId,
      ev.toolCallId,
      ev.kind,
      JSON.stringify(ev.prompt),
      JSON.stringify(meta),
      ev.expiresAt,
    );
    if (!inserted.rowsWritten) return;

    this.host.ctx.storage.sql.exec(
      `UPDATE runs SET status = 'input_required' WHERE id = ?1`,
      runId,
    );
    if (tracker) {
      tracker.pausedForInput = true;
      this.persistTrackerProgress(tracker);
      if (tracker.slotAcquired) {
        tracker.slotAcquired = false;
        const cfg = this.host.getConfig();
        await getTenantStub(this.host.env, cfg.tenantId)
          .releaseSlot(runId)
          .catch(() => {});
      }
    }

    this.host.recordAndBroadcastEvent(runId, "input_required", {
      inputId: ev.inputId,
      kind: ev.kind,
      toolCallId: ev.toolCallId,
      prompt: ev.prompt,
      expiresAt: ev.expiresAt,
      input: {
        id: ev.inputId,
        runId,
        toolCallId: ev.toolCallId,
        kind: ev.kind,
        prompt: ev.prompt,
        status: "pending",
        expiresAt: ev.expiresAt,
      },
    });
    this.host.setActiveRunId(null);
    this.host.notifyRunWaiters(runId);
  }

  private handleInputCancelled(inputId: string): void {
    this.host.ctx.storage.sql.exec(
      `UPDATE inputs SET status = 'cancelled' WHERE id = ?1 AND status = 'pending'`,
      inputId,
    );
  }

  private findMostRecentActiveRunId(): string | null {
    const row = this.host.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM runs WHERE status IN ('running', 'queued', 'input_required') ORDER BY started_at DESC LIMIT 1`,
      )
      .toArray()[0];
    return row?.id ?? null;
  }

  /**
   * Ensures the Pi root conversation exists. Idempotent: if the Pi root already
   * exists, `harness.root` is skipped.
   */
  async ensureRoot(cfg?: AgentConfig, maxTurns?: number): Promise<{ created: boolean }> {
    await this.ensureStarted();
    const curCfg = cfg ?? this.host.getConfig();
    await this.ensureExtensionsInstalled(curCfg);

    if (this.rootReady || this.hasPiRootConversation()) {
      this.rootReady = true;
      return { created: false };
    }

    const initialChange = this.buildAgentChange(curCfg, maxTurns);
    const { created } = await this.harness.root({
      agent: initialChange,
    });
    if (created) {
      this.lastAppliedAgentConfigFp = this.agentChangeFingerprint(initialChange);
    }

    this.rootReady = true;
    return { created };
  }

  /**
   * Imports legacy/v1 or exported messages directly into `pi-durable` (either creating
   * the root conversation or appending to an existing root conversation for chunked imports).
   * Splits large imports into memory-safe batches without breaking tool-call/result pairs.
   */
  async importV1Messages(
    cfg: AgentConfig,
    messages: readonly StoredMessage[],
    opts?: { append?: boolean; compaction?: LegacyCompactionRow | null },
  ): Promise<{ imported: number; alreadyImported: boolean; messageCount: number }> {
    await this.ensureStarted();
    await this.ensureExtensionsInstalled(cfg);
    const modelRef = parsePiModelRef(cfg.model, this.host.env);

    const rootExists = this.rootReady || this.hasPiRootConversation();
    if (!opts?.append && rootExists) {
      this.rootReady = true;
      const existingCount = (await this.getMessageCount()) ?? 0;
      if (existingCount > 0) {
        return { imported: 0, alreadyImported: true, messageCount: existingCount };
      }
    }

    const MAX_BATCH_ROWS = 100;
    const MAX_BATCH_BYTES = 2 * 1024 * 1024;
    const batches: StoredMessage[][] = [];
    let currentBatch: StoredMessage[] = [];
    let currentBytes = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const msgBytes = JSON.stringify(msg.content ?? {}).length;
      const shouldFlush =
        currentBatch.length > 0 &&
        msg.role !== "tool" &&
        (currentBatch.length >= MAX_BATCH_ROWS || currentBytes + msgBytes > MAX_BATCH_BYTES);
      if (shouldFlush) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBytes = 0;
      }
      currentBatch.push(msg);
      currentBytes += msgBytes;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    const persistMeta = (importedMeta: ImportedEntryMeta[]) => {
      if (importedMeta.length === 0) return;
      this.host.ctx.storage.transactionSync(() => {
        for (const item of importedMeta) {
          this.recordEntryMeta(item.entryId, item.runId, item.meta);
        }
      });
    };

    let imported = 0;
    let startIndex = 0;
    if (!rootExists) {
      const firstBatch = batches[0] ?? [];
      const initialChange = this.buildAgentChange(cfg);
      let importedMeta: ImportedEntryMeta[] = [];
      let batchImported = 0;
      const { created } = await this.harness.root({
        agent: initialChange,
        init: async (tx, convId) => {
          if (firstBatch.length > 0 || opts?.compaction) {
            const res = await importLegacyTranscriptToPi(
              tx,
              convId,
              opts?.compaction ?? null,
              firstBatch,
              modelRef,
            );
            importedMeta = res.importedMeta;
            batchImported = res.importedEntries;
          }
        },
      });
      if (created) {
        this.lastAppliedAgentConfigFp = this.agentChangeFingerprint(initialChange);
        persistMeta(importedMeta);
        imported += batchImported;
        startIndex = 1;
      }
      this.rootReady = true;
    } else {
      this.rootReady = true;
    }

    if (startIndex < batches.length) {
      const pi = await this.harness.pi();
      for (let i = startIndex; i < batches.length; i++) {
        const batch = batches[i]!;
        if (batch.length === 0) continue;
        let importedMeta: ImportedEntryMeta[] = [];
        let batchImported = 0;
        await pi.commit(async (tx) => {
          const res = await importLegacyTranscriptToPi(
            tx,
            ROOT_CONVERSATION_ID,
            i === 0 ? (opts?.compaction ?? null) : null,
            batch,
            modelRef,
          );
          importedMeta = res.importedMeta;
          batchImported = res.importedEntries;
        }, BG);
        persistMeta(importedMeta);
        imported += batchImported;
      }
    } else if (startIndex === 0 && opts?.compaction) {
      const pi = await this.harness.pi();
      await pi.commit(async (tx) => {
        const res = await importLegacyTranscriptToPi(
          tx,
          ROOT_CONVERSATION_ID,
          opts.compaction ?? null,
          [],
          modelRef,
        );
        imported += res.importedEntries;
      }, BG);
    }

    const messageCount = (await this.getMessageCount()) ?? imported;
    return { imported, alreadyImported: false, messageCount };
  }

  private async refreshModels(
    cfg: AgentConfig,
    opts?: {
      keyScope?: string | null;
      hints?: StartRunHints;
    },
  ): Promise<void> {
    const keyScope = opts?.keyScope !== undefined ? opts.keyScope : (cfg.keyScope ?? null);
    const prefetchedCredentials: Record<string, import("../types.ts").ProviderCredentials | null> = {};
    if (opts?.hints?.prefetchedProvider) {
      const ref = parsePiModelRef(opts.hints.prefetchedProvider.model, this.host.env);
      prefetchedCredentials[ref.provider] = opts.hints.prefetchedProvider.credentials;
    }
    this.currentModels = await buildPiModels({
      env: this.host.env,
      tenantId: cfg.tenantId,
      keyScope,
      rawModel: cfg.model,
      prefetchedCredentials: Object.keys(prefetchedCredentials).length > 0 ? prefetchedCredentials : undefined,
      getOutputSchema: () => this.getOrRehydrateActiveTracker()?.outputSchema ?? null,
    });
  }

  private async buildUserInputWithFiles(
    cfg: AgentConfig,
    prompt: string,
    refs: Array<{ lineage: string; file: RunFile }>,
  ): Promise<{ userInput: UserInput; verifiedFiles: StoredRunFile[] }> {
    if (refs.length === 0) {
      return { userInput: prompt, verifiedFiles: [] };
    }
    const cfs = new CamelFsClient(this.host.env, cfg.tenantId);
    const verified = await verifyRunFiles(cfs, refs, {
      env: this.host.env,
      tenantId: cfg.tenantId,
    });

    const blocks: (TextContent | ImageContent)[] = [];
    const lines = [
      prompt,
      ...verified.map(
        (f) =>
          `Workspace attachment ${JSON.stringify(f.path)} at commit ${f.commit} (${f.contentType}, ${f.size} bytes).`,
      ),
    ].filter(Boolean);
    blocks.push({ type: "text", text: lines.join("\n") });

    for (const f of verified) {
      if (!isImageAttachment(f)) continue;
      if (f.resized && this.host.env.MEDIA_BUCKET) {
        const obj = await this.host.env.MEDIA_BUCKET.get(toolImageKey(cfg.tenantId, f.resized));
        if (obj) {
          const buf = Buffer.from(await obj.arrayBuffer());
          blocks.push({
            type: "image",
            mimeType: f.resized.contentType,
            data: buf.toString("base64"),
          });
          continue;
        }
      }
      const read = await cfs.read(f.lineage, { at: f.commit, path: f.path, limit: f.size + 1 });
      if (read.base64) {
        blocks.push({
          type: "image",
          mimeType: f.contentType,
          data: read.base64,
        });
      }
    }

    return { userInput: blocks, verifiedFiles: verified };
  }

  ensureWatchingActiveRun(): void {
    const tracker = this.activeTracker;
    if (
      !tracker ||
      tracker.settling ||
      tracker.settled ||
      tracker.pausedForInput ||
      tracker.aborted ||
      tracker.watchHandle ||
      tracker.watchStarting ||
      !this.lifecycle.isStarted()
    ) {
      return;
    }
    void this.startWatchForTracker(tracker).catch(() => {});
  }

  private latestRootEntryId(): number {
    const latest = this.host.ctx.storage.sql.exec<{ id: number }>(
      `SELECT id FROM pi_entries WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1`,
      ROOT_CONVERSATION_ID,
    ).toArray()[0];
    return latest?.id ?? 0;
  }

  private async refreshRunSubmission(tracker: ActiveRunTracker): Promise<void> {
    if (tracker.submissionFinished || tracker.settled) return;
    // Pi indexes the original operation ID and stores the entry where it placed the prompt.
    // An unplaced or absent submission proves nothing about ownership of the transcript.
    const storage = await this.harness.storage();
    const submission = await storage.submissionByRequest(ROOT_CONVERSATION_ID, tracker.runId, BG);
    if (submission?.type !== "input" || tracker.submissionFinished || tracker.settled) return;
    tracker.submissionId = submission.id;
    tracker.submissionFinished = submission.status === "done" || submission.status === "unanswered";
    tracker.answerEntryId = submission.answer ?? null;
    if (tracker.baselineEntryId === null && submission.entry !== undefined) {
      tracker.baselineEntryId = Number(submission.entry) - 1;
      tracker.lastEntryId = tracker.baselineEntryId;
      this.persistTrackerProgress(tracker);
    }
  }

  private observeFollowingRun(tracker: ActiveRunTracker, live: LiveState | undefined): void {
    const run = live?.run;
    if (tracker.submissionFinished && tracker.submissionId !== null && tracker.baselineEntryId !== null &&
        tracker.nextRunEntryId === null && run?.first && run.first > tracker.baselineEntryId &&
        run.inputs.length > 0 && !run.inputs.includes(tracker.submissionId)) {
      tracker.nextRunEntryId = run.first;
    }
  }

  private isBeforeFollowingRun(tracker: ActiveRunTracker, entry: EntryRecord): boolean {
    if (tracker.nextRunEntryId !== null) return entry.id < tracker.nextRunEntryId;
    // A late steer can start and finish in Pi before we observe its live run. The next
    // prompt belongs to that run. Results of a tool-terminating answer can precede it.
    if (tracker.answerEntryId !== null && entry.id > tracker.answerEntryId &&
        CamelRunUserEntry.is(entry) && typeof entry.data.runId === "string" && entry.data.runId !== tracker.runId) {
      tracker.nextRunEntryId = entry.id;
      return false;
    }
    return true;
  }

  private addToolStart(
    tracker: ActiveRunTracker,
    events: RunProgressEvent[],
    data: { callId: string; name: string; parentCallId?: string; args?: unknown },
  ): void {
    if (tracker.openToolCalls.has(data.callId) || tracker.seenToolEnds.has(data.callId)) return;
    tracker.openToolCalls.add(data.callId);
    events.push({ type: "tool_call_start", data });
  }

  private addToolEnd(
    tracker: ActiveRunTracker,
    events: RunProgressEvent[],
    data: {
      callId: string;
      name: string;
      ok: boolean;
      parentCallId?: string;
      isError?: boolean;
      error?: unknown;
    },
  ): void {
    if (tracker.seenToolEnds.has(data.callId)) return;
    tracker.seenToolEnds.add(data.callId);
    tracker.openToolCalls.delete(data.callId);
    tracker.toolCalls.push({ id: data.callId, name: data.name, ok: data.ok });
    events.push({ type: "tool_call_end", data });
  }

  private broadcastRunProgress(tracker: ActiveRunTracker, events: RunProgressEvent[]): void {
    for (const { type, data } of events) {
      this.host.broadcastEphemeralEvent(tracker.runId, type, data);
    }
  }

  private startGenerationAttempt(tracker: ActiveRunTracker, taskId: number, attempt: number): void {
    if (taskId === tracker.generationTaskId && attempt === tracker.generationAttempt) return;
    if (taskId !== tracker.generationTaskId) tracker.generationTextStart = tracker.accumulatedText.length;
    tracker.generationTaskId = taskId;
    tracker.generationAttempt = attempt;
    tracker.attemptTextStart = tracker.accumulatedText.length;
    tracker.partialTextLen = 0;
  }

  private appendGenerationText(
    tracker: ActiveRunTracker,
    text: string,
    events: RunProgressEvent[],
    committed: boolean,
  ): void {
    const earlier = tracker.accumulatedText.slice(tracker.generationTextStart, tracker.attemptTextStart);
    let published = tracker.partialTextLen;
    if (committed && published > 0) {
      // A retry may have committed without a live frame. Verify the prefix instead of
      // assuming that this assistant entry came from the last observed attempt.
      const suffix = tracker.accumulatedText.slice(tracker.attemptTextStart);
      const prefix = earlier.slice(0, Math.max(0, published - suffix.length));
      published = commonPrefixLength(text, prefix + suffix);
    }
    const delta = text.slice(Math.max(published, commonPrefixLength(text, earlier)));
    tracker.partialTextLen = Math.max(tracker.partialTextLen, text.length);
    if (delta) {
      tracker.accumulatedText += delta;
      events.push({ type: "text_delta", data: { delta } });
    }
  }

  private processCommittedEntry(tracker: ActiveRunTracker, entry: EntryRecord): void {
    const entryNum = Number(entry.id);
    if (tracker.lastEntryId === null || entryNum <= tracker.lastEntryId || tracker.settled) return;
    tracker.lastEntryId = entryNum;
    const events: RunProgressEvent[] = [];

    if (AssistantEntry.is(entry)) {
      tracker.lastMessageEntryId = entryNum;
      const msg = entry.model?.[0];
      if (msg?.role === "assistant") {
        const taskId = Number(entry.byTaskId ?? entry.id);
        if (taskId !== tracker.generationTaskId) this.startGenerationAttempt(tracker, taskId, -1);
        this.appendGenerationText(tracker, extractAssistantText(msg), events, true);
        // Pi can persist the interrupted attempt as an aborted assistant entry and then
        // retry in the same task. Its streamed prefix still belongs to this generation.
        if (msg.stopReason !== "aborted" && msg.stopReason !== "error") {
          tracker.generationTaskId = null;
        }
        for (const tc of extractAssistantToolCalls(msg)) {
          this.addToolStart(tracker, events, { callId: tc.id, name: tc.name, args: tc.arguments ?? {} });
        }
      }
    } else if (ToolResultEntry.is(entry)) {
      tracker.lastMessageEntryId = entryNum;
      const msg = entry.model?.[0];
      if (msg?.role === "toolResult") {
        this.addToolEnd(tracker, events, {
          callId: msg.toolCallId,
          name: msg.toolName,
          ok: !msg.isError,
          ...(msg.isError ? { isError: true } : {}),
        });
      }
    } else if (CamelRunUserEntry.is(entry) && entry.data.runId === tracker.runId) {
      tracker.lastMessageEntryId = entryNum;
    }

    // Pi persists transcript entries before publishing them. Save our delivery cursor
    // and the progress it represents before exposing any events.
    const persisted = this.host.ctx.storage.transactionSync(() => {
      if (!this.persistStreamProgress(tracker, events)) return false;
      if (CompactionEntry.is(entry)) {
        this.host.recordAndBroadcastEvent(null, "context_compacted", {
          upToSeq: entry.head !== undefined ? Number(entry.head) : entryNum,
          reason: (entry.data as { reason?: string } | undefined)?.reason ?? "auto",
        });
      }
      if (tracker.lastMessageEntryId === entryNum && tracker.lastRepoCommit) {
        this.recordEntryMeta(entryNum, tracker.runId, undefined, tracker.lastRepoCommit);
      }
      return true;
    });
    if (persisted && !tracker.aborted) this.broadcastRunProgress(tracker, events);
  }

  private async syncRunEntriesFromPi(tracker: ActiveRunTracker, through?: EntryId): Promise<void> {
    if (tracker.nextRunEntryId !== null) {
      through = Math.min(through ?? Number.MAX_SAFE_INTEGER, tracker.nextRunEntryId - 1) as EntryId;
    }
    if (tracker.lastEntryId === null || (through !== undefined && through <= tracker.lastEntryId)) return;
    const minEntryId = (tracker.lastEntryId + 1) as EntryId;
    const conv = await this.getRootConversation();
    if (!conv) return;
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    do {
      const page = await conv.entries(
        { order: "ascending", minEntryId, maxEntryId: through },
        RUN_ENTRY_PAGE_SIZE,
        cursor,
        BG,
      );
      for (const entry of page.items) {
        if (!this.isBeforeFollowingRun(tracker, entry)) return;
        this.processCommittedEntry(tracker, entry);
      }
      cursor = page.next;
    } while (cursor && !tracker.settled);
  }

  private processLiveProgress(tracker: ActiveRunTracker, live: LiveState | undefined): void {
    if (tracker.submissionId === null || !live?.run?.inputs.includes(tracker.submissionId)) return;
    const events: RunProgressEvent[] = [];

    if (live.generation?.message) {
      const taskId = Number(live.run.taskId);
      const { attempt, message } = live.generation;
      this.startGenerationAttempt(tracker, taskId, attempt);
      this.appendGenerationText(tracker, extractAssistantText(message as unknown as AssistantMessage), events, false);
    }

    for (const slot of live.tools ?? []) {
      this.addToolStart(tracker, events, { callId: slot.callId, name: slot.name });
      if (slot.status === "done") {
        const ok = !slot.diagnostics?.some((d) => d.severity === "error");
        this.addToolEnd(tracker, events, { callId: slot.callId, name: slot.name, ok });
      }
    }
    for (const nested of live.nestedTools ?? []) {
      const call = { callId: nested.callId, name: nested.name, parentCallId: nested.parentCallId };
      this.addToolStart(tracker, events, { ...call, args: nested.arguments ?? {} });
      if (nested.status === "done") {
        this.addToolEnd(tracker, events, {
          ...call,
          ok: !nested.summary?.isError,
          ...(nested.summary?.error ? { error: nested.summary.error } : {}),
        });
      }
    }

    // Pi can publish live documents before persisting them. Claim only new output from
    // this generation attempt so its next publication can resume without re-emitting it.
    if (events.length > 0 && this.persistStreamProgress(tracker, events)) {
      this.broadcastRunProgress(tracker, events);
    }
  }

  private async startWatchForTracker(tracker: ActiveRunTracker): Promise<void> {
    if (tracker.watchHandle || tracker.watchStarting || tracker.settling || tracker.settled || tracker.aborted) return;
    tracker.watchStarting = true;
    try {
      await tracker.watchProcessing?.catch(() => {});
      await this.refreshRunSubmission(tracker);
      if (tracker.lastEntryId === null || tracker.settling || tracker.settled || tracker.aborted) return;
      const watch = await this.harness.session(ROOT_SESSION).watch({
        from: (tracker.lastEntryId + 1) as EntryId,
        min: 1,
        max: RUN_ENTRY_PAGE_SIZE,
      });
      if (tracker.settling || tracker.settled || tracker.aborted) {
        await watch.stop();
        return;
      }
      tracker.watchHandle = watch;
      void watch.closed.then(() => {
        if (tracker.watchHandle === watch) tracker.watchHandle = null;
      });
      const processView = async (view: typeof watch.value) => {
        const canProcess = () => tracker.watchHandle === watch &&
          !tracker.settled && !tracker.pausedForInput && !tracker.aborted;
        if (!canProcess()) return;
        const live = view.docs["pi.live"] as LiveState | undefined;
        if (tracker.submissionId === null || !live?.run?.inputs.includes(tracker.submissionId)) {
          await this.refreshRunSubmission(tracker);
          if (!canProcess()) return;
          this.observeFollowingRun(tracker, live);
        }
        // A slow subscriber can fall behind the watch's bounded window.
        if (view.before !== undefined) await this.syncRunEntriesFromPi(tracker, view.before);
        if (!canProcess()) return;
        for (const entry of view.entries) {
          if (!this.isBeforeFollowingRun(tracker, entry)) break;
          this.processCommittedEntry(tracker, entry);
        }
        this.processLiveProgress(tracker, live);
      };

      const consume = async (view: typeof watch.value) => {
        const processing = processView(view);
        tracker.watchProcessing = processing;
        try {
          await processing;
        } finally {
          if (tracker.watchProcessing === processing) tracker.watchProcessing = null;
        }
      };
      try {
        await consume(watch.value);
      } catch (error) {
        await watch.stop();
        throw error;
      }
      if (tracker.watchHandle === watch) {
        watch.start(async (call) => {
          if (call.kind === "value") await consume(call.value);
        });
      }
    } finally {
      tracker.watchStarting = false;
    }
  }

  private trackSubmissionSettlement(
    tracker: ActiveRunTracker,
    attachWatch = false,
  ): Promise<void> {
    if (tracker.watchPromise) return tracker.watchPromise;
    const work = (async () => {
      const cfg = this.host.getConfig();
      const tenantStub = getTenantStub(this.host.env, cfg.tenantId);
      let warnedAboutBoundary = false;
      const warnIfBoundaryMissing = () => {
        if (tracker.baselineEntryId !== null || warnedAboutBoundary) return;
        warnedAboutBoundary = true;
        console.warn(JSON.stringify({
          event: "run_recovery_boundary_missing",
          agentId: cfg.id,
          runId: tracker.runId,
        }));
      };

      try {
        if (attachWatch && !tracker.watchHandle) {
          await this.startWatchForTracker(tracker).catch(() => {});
        }
        const result = await this.harness.wait(tracker.runId, { session: ROOT_SESSION });

        // Give the last watch publication a chance to flush, then finish from Pi's committed transcript.
        tracker.settling = true;
        if (tracker.watchHandle) {
          await new Promise((r) => setTimeout(r, 0));
          const watch = tracker.watchHandle;
          tracker.watchHandle = null;
          await watch?.stop();
        }
        await tracker.watchProcessing;
        await this.refreshRunSubmission(tracker);
        warnIfBoundaryMissing();
        if (tracker.baselineEntryId !== null && (result.status === "done" || result.reason !== "not_found")) {
          // A persisted baseline can exist even if the isolate stopped before Pi accepted the prompt.
          const pi = await this.harness.pi();
          this.observeFollowingRun(tracker, await pi.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BG));
          await this.syncRunEntriesFromPi(tracker);
        }

        if (tracker.settled) return;

        await this.recordRunRepoCommit(tracker, this.host.readConfigOrNull() ?? cfg);

        const postRunSpendError =
          tracker.spendLimitError ??
          (tracker.spendLimitUsd !== null &&
          tracker.spendLimitUsd >= 0 &&
          tracker.usage.costUsd > tracker.spendLimitUsd
            ? {
                code: "spend_limit_exceeded",
                message: `Run spend limit exceeded ($${tracker.usage.costUsd.toFixed(6)} > $${tracker.spendLimitUsd.toFixed(6)})`,
              }
            : null);

        if (result.status === "done" && !postRunSpendError) {
          const text = result.text || tracker.accumulatedText;
          const output = tracker.outputSchema ? tryParseStructuredOutput(text) : null;
          this.finishTrackedRun(tracker, { status: "completed", text, output });
        } else {
          const isCancelled =
            !postRunSpendError &&
            (tracker.aborted || (result.status !== "done" && result.reason === "aborted"));
          const error = postRunSpendError
            ? postRunSpendError
            : isCancelled
              ? { code: "cancelled", message: "Cancelled via abort" }
              : (() => {
                  const code = (result.status !== "done" ? result.reason : null) || "run_failed";
                  return { code, message: `Run ended unanswered (${code})` };
                })();
          this.finishTrackedRun(tracker, { status: isCancelled ? "cancelled" : "failed", error });
        }
        tracker.settled = true;

        // Settle usage with TenantDO
        if (
          tracker.usage.inputTokens > 0 ||
          tracker.usage.outputTokens > 0 ||
          tracker.usage.vmMs > 0 ||
          tracker.usage.costUsd > 0
        ) {
          const refId = `run:${tracker.runId}`;
          const isByok = tracker.usage.byok === true;
          let platformCostUsd = tracker.usage.costUsd;

          if (isByok) {
            const vmCostUsd = calculatePiCostUsd("mock", 0, 0, tracker.usage.vmMs, 0);
            let uncoveredInfraUsd = vmCostUsd;
            if (vmCostUsd > 0) {
              const infra = await consumeInfraCredit(
                this.host.env,
                cfg.tenantId,
                vmCostUsd,
                refId,
              ).catch(() => ({
                coveredUsd: 0,
                uncoveredUsd: vmCostUsd,
                remainingUsd: 0,
              }));
              uncoveredInfraUsd = infra.uncoveredUsd;
            }
            if (uncoveredInfraUsd > 0) {
              const profile = await tenantStub.getProfile().catch(() => null);
              const availableBalance = Math.max(0, profile?.balanceUsd ?? 0);
              platformCostUsd = Number(Math.min(availableBalance, uncoveredInfraUsd).toFixed(8));
            } else {
              platformCostUsd = 0;
            }
          }

          await tenantStub
            .settleUsage({
              refId,
              model: cfg.model,
              inputTokens: tracker.usage.inputTokens,
              outputTokens: tracker.usage.outputTokens,
              cacheReadTokens: tracker.usage.cacheReadTokens ?? 0,
              vmMs: tracker.usage.vmMs,
              costUsd: platformCostUsd,
              note: `Agent ${cfg.key} (${cfg.id})`,
              agentId: cfg.id,
              actor: tracker.actor,
              ...(isByok ? { byok: true } : {}),
            })
            .catch(() => {});
        }
      } catch (err) {
        warnIfBoundaryMissing();
        tracker.settling = true;
        const apiErr = extractApiError(err);
        const code = apiErr?.code ?? "run_failed";
        const message = apiErr?.message ?? (err instanceof Error ? err.message : String(err));
        this.finishTrackedRun(tracker, { status: "failed", error: { code, message } });
        tracker.settled = true;
      } finally {
        if (tracker.watchHandle) {
          await tracker.watchHandle.stop().catch(() => {});
          tracker.watchHandle = null;
        }
        if (tracker.slotAcquired) {
          tracker.slotAcquired = false;
          await tenantStub.releaseSlot(tracker.runId).catch(() => {});
        }
        if (this.activeTracker === tracker) {
          this.activeTracker = null;
        }
        if (this.host.getActiveRunId() === tracker.runId) {
          this.host.setActiveRunId(null);
        }
        if (!this.host.isDestroying()) {
          await this.host.scheduleNextAlarm().catch(() => {});
        }
        this.host.onRunSettled?.(tracker.runId);
        this.host.notifyRunWaiters(tracker.runId);
      }
    })();

    tracker.watchPromise = work;
    this.host.ctx.waitUntil(work);
    return work;
  }

  private finishTrackedRun(
    tracker: ActiveRunTracker,
    terminal: { status: "completed"; text: string; output: unknown } |
      { status: "failed" | "cancelled"; error: { code: string; message: string } },
  ): void {
    const completed = terminal.status === "completed";
    this.host.ctx.storage.transactionSync(() => {
      const updated = this.host.ctx.storage.sql.exec(
        `UPDATE runs
         SET status = ?1, text = ?2, output_json = ?3, tool_calls_json = ?4,
             files_changed_json = ?5, usage_json = ?6, error_json = ?7, ended_at = ?8,
             pi_progress_json = NULL
         WHERE id = ?9 AND status IN ('running', 'input_required')`,
        terminal.status,
        completed ? terminal.text : tracker.accumulatedText,
        completed && terminal.output !== null ? JSON.stringify(terminal.output) : null,
        JSON.stringify(tracker.toolCalls),
        JSON.stringify([...tracker.filesChanged]),
        JSON.stringify(tracker.usage),
        completed ? null : JSON.stringify(terminal.error),
        Date.now(),
        tracker.runId,
      );
      if (updated.rowsWritten === 0) return;
      if (completed) {
        const delta = terminal.text.slice(tracker.accumulatedText.length);
        if (delta && tracker.baselineEntryId !== null) {
          this.host.broadcastEphemeralEvent(tracker.runId, "text_delta", { delta });
        }
        this.host.recordAndBroadcastEvent(tracker.runId, "run_completed", {
          runId: tracker.runId,
          text: terminal.text,
          output: terminal.output,
          usage: tracker.usage,
        });
      } else {
        this.host.recordAndBroadcastEvent(
          tracker.runId,
          terminal.status === "cancelled" ? "run_cancelled" : "run_failed",
          terminal.status === "cancelled" ? { runId: tracker.runId } : {
            runId: tracker.runId,
            error: terminal.error,
          },
        );
      }
    });
  }

  /**
   * Executes a single already-admitted queued run (owned by `AgentDO.drainRunQueue`)
   * with full Pi durability, billing, spend-limit enforcement, and streaming events.
   * Returns once the run reaches a terminal or `input_required` state.
   */
  async executeRun(params: {
    runId: string;
    prompt: string;
    actor?: string;
    files: Array<{ lineage: string; file: RunFile }>;
    outputSchema: Record<string, unknown> | null;
    maxSteps?: number;
    spendLimitUsd: number | null;
    keyScope?: string | null;
    hints?: StartRunHints;
    slotAcquired: boolean;
  }): Promise<RunRecord> {
    const cfg = this.host.getConfig();
    const tenantStub = getTenantStub(this.host.env, cfg.tenantId);
    const { runId, prompt, actor, outputSchema, maxSteps, spendLimitUsd, hints } = params;
    let slotAcquired = params.slotAcquired;

    const failImmediately = (code: string, message: string): RunRecord => {
      if (slotAcquired) {
        slotAcquired = false;
        void tenantStub.releaseSlot(runId).catch(() => {});
      }
      this.host.ctx.storage.transactionSync(() => {
        const updated = this.host.ctx.storage.sql.exec(
          `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2
           WHERE id = ?3 AND status IN ('queued', 'running')`,
          JSON.stringify({ code, message }),
          Date.now(),
          runId,
        );
        if (updated.rowsWritten > 0) {
          this.host.recordAndBroadcastEvent(runId, "run_failed", { runId, error: { code, message } });
        }
      });
      this.host.notifyRunWaiters(runId);
      return this.host.materializeRunRecord(runId);
    };

    if (spendLimitUsd !== null && spendLimitUsd <= 0) {
      return failImmediately(
        "spend_limit_exceeded",
        `Run spend limit exceeded ($0.000000 >= $${spendLimitUsd.toFixed(6)})`,
      );
    }

    const effectiveScope =
      hints?.prefetchedProvider?.keyScope !== undefined
        ? (hints.prefetchedProvider.keyScope ?? null)
        : (params.keyScope ?? cfg.keyScope ?? null);
    const { isByok, prefetchedProvider } = await resolveTenantByokProvider(
      this.host.env,
      cfg.tenantId,
      cfg.model,
      hints?.prefetchedProvider,
      effectiveScope,
    );

    if (!cfg.model.startsWith("mock") && !isByok && !platformCreditReserve(this.host.env, cfg.tenantId)) {
      const balanceUsd =
        hints?.prefetchedBalanceUsd !== undefined
          ? hints.prefetchedBalanceUsd
          : (await tenantStub.getProfile())?.balanceUsd;
      if (balanceUsd !== undefined && balanceUsd <= 0) {
        return failImmediately(
          "insufficient_credits",
          "Tenant balance is exhausted. Top up credits or add a BYOK provider key.",
        );
      }
    }

    try {
      await this.ensureStarted();
      await this.refreshModels(cfg, {
        keyScope: params.keyScope,
        hints: prefetchedProvider ? { ...(hints ?? {}), prefetchedProvider } : hints,
      });
      if (!cfg.model.startsWith("mock")) {
        const ref = parsePiModelRef(cfg.model, this.host.env);
        const providerObj = this.currentModels?.getProvider(ref.provider);
        const resolvedAuth = providerObj?.auth?.apiKey
          ? await providerObj.auth.apiKey.resolve({
              ctx: {},
              signal: new AbortController().signal,
            } as never)
          : undefined;
        if (!resolvedAuth) {
          return failImmediately(
            "missing_provider_key",
            `No API key configured for provider '${ref.provider}'`,
          );
        }
      }
      await this.ensureRoot(cfg, maxSteps);
      await this.ensureMcpExtensionReady(cfg);

      const { userInput, verifiedFiles } = await this.buildUserInputWithFiles(
        cfg,
        prompt,
        params.files,
      );

      const conv = await this.getRootConversation();
      if (conv) {
        const nextChange = this.buildAgentChange(cfg, maxSteps);
        const nextFp = this.agentChangeFingerprint(nextChange);
        if (nextFp !== this.lastAppliedAgentConfigFp) {
          await conv.configure(nextChange, BG);
          this.lastAppliedAgentConfigFp = nextFp;
        }
      }

      const runRow = this.host.ctx.storage.sql
        .exec<{ idempotency_key: string | null }>(
          `SELECT idempotency_key FROM runs WHERE id = ?1 LIMIT 1`,
          runId,
        )
        .toArray()[0];

      const baselineEntryId = this.latestRootEntryId();
      const tracker: ActiveRunTracker = {
        runId,
        actor,
        outputSchema,
        spendLimitUsd,
        usage: isByok ? { ...emptyUsage(), byok: true } : emptyUsage(),
        filesChanged: new Set(),
        toolCalls: [],
        openToolCalls: new Set(),
        seenToolEnds: new Set(),
        baselineEntryId,
        submissionId: null,
        submissionFinished: false,
        answerEntryId: null,
        nextRunEntryId: null,
        lastEntryId: baselineEntryId,
        lastMessageEntryId: null,
        generationTaskId: null,
        generationAttempt: -1,
        generationTextStart: 0,
        attemptTextStart: 0,
        partialTextLen: 0,
        lastRepoCommit: null,
        accumulatedText: "",
        slotAcquired,
        settling: false,
        settled: false,
        pausedForInput: false,
        spendLimitError: null,
        aborted: false,
        recovered: false,
        watchStarting: false,
        watchHandle: null,
        watchProcessing: null,
        watchPromise: null,
      };
      const started = this.host.ctx.storage.transactionSync(() => {
        const updated = this.host.ctx.storage.sql.exec(
          `UPDATE runs SET status = 'running', baseline_entry_id = ?1, usage_json = ?2
           WHERE id = ?3 AND status = 'queued'`,
          baselineEntryId,
          JSON.stringify(tracker.usage),
          runId,
        );
        if (updated.rowsWritten === 0) return false;
        slotAcquired = false; // Ownership transferred to tracker
        this.activeTracker = tracker;
        this.host.setActiveRunId(runId);
        this.host.recordAndBroadcastEvent(runId, "run_started", {
          runId,
          prompt,
          ...(actor ? { actor } : {}),
        });
        return true;
      });
      if (!started) return failImmediately("cancelled", "Run stopped before Pi accepted the prompt");

      if (this.host.hasEventSubscribers()) {
        await this.startWatchForTracker(tracker);
      }

      const entryData: JsonObject = {
        runId,
        ...(actor ? { actor, requestId: runRow?.idempotency_key ?? null } : {}),
        ...(verifiedFiles.length > 0
          ? { files: JSON.parse(JSON.stringify(verifiedFiles)) }
          : {}),
      };
      await this.harness.submit(userInput, {
        session: ROOT_SESSION,
        operationId: runId,
        whenBusy: "followUp",
        entry: { kind: CamelRunUserEntry.kind, data: entryData },
      });

      const waitPromise = this.host.waitForRunSettlement(runId);
      this.trackSubmissionSettlement(tracker);
      return await waitPromise;
    } catch (err) {
      if (this.activeTracker?.runId === runId) {
        if (this.activeTracker.watchHandle) {
          await this.activeTracker.watchHandle.stop().catch(() => {});
        }
        if (this.activeTracker.slotAcquired) {
          this.activeTracker.slotAcquired = false;
          await tenantStub.releaseSlot(runId).catch(() => {});
        }
        this.activeTracker = null;
      }
      if (this.host.getActiveRunId() === runId) {
        this.host.setActiveRunId(null);
      }
      const apiErr = extractApiError(err);
      return failImmediately(
        apiErr?.code ?? "run_failed",
        apiErr?.message ?? (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async finalizeAbortedInputs(
    runId: string,
    inputs: Array<{ id: string; tool_call_id: string; prompt_json: string | null }>,
    reasonText: string,
  ): Promise<void> {
    for (const inp of inputs) {
      let toolName = "ask_human";
      if (inp.prompt_json) {
        try {
          const parsed = JSON.parse(inp.prompt_json) as { tool?: string };
          if (typeof parsed.tool === "string" && parsed.tool) toolName = parsed.tool;
        } catch {
          // ignore
        }
      }

      this.host.broadcastEphemeralEvent(runId, "tool_call_end", {
        callId: inp.tool_call_id,
        name: toolName,
        ok: false,
        error: reasonText,
      });
    }
  }

  private async stopActiveTrackerForAbort(runId?: string): Promise<string | null> {
    const tracker = this.activeTracker;
    if (!tracker || tracker.settled || (runId !== undefined && tracker.runId !== runId)) {
      return null;
    }
    tracker.aborted = true;
    if (tracker.watchHandle) {
      const handle = tracker.watchHandle;
      tracker.watchHandle = null;
      await handle.stop().catch(() => {});
    }
    return tracker.runId;
  }

  async abortExpiredInput(inp: {
    id: string;
    run_id: string;
    tool_call_id: string;
    prompt_json: string | null;
  }): Promise<void> {
    await this.stopActiveTrackerForAbort(inp.run_id);
    await this.ensureStarted();
    await this.harness.abort({ session: ROOT_SESSION, operationId: inp.run_id }).catch(() => {});
    await this.finalizeAbortedInputs(
      inp.run_id,
      [inp],
      "Not answered: the request for input expired.",
    );
  }

  async supersedePendingInputRuns(actor?: string): Promise<string[]> {
    const pausedRuns = this.host.ctx.storage.sql
      .exec<{ id: string; actor: string | null }>(
        `SELECT id, actor FROM runs WHERE status = 'input_required' AND batched_into IS NULL ORDER BY started_at ASC`,
      )
      .toArray();
    const matching = pausedRuns.filter((r) => !actor || !r.actor || r.actor === actor);
    if (matching.length === 0) return [];

    const reasonText = "Not answered: the user sent a new message instead (next).";
    const pendingByRun = new Map<
      string,
      Array<{ id: string; tool_call_id: string; prompt_json: string | null }>
    >();

    // Update inputs to 'superseded' BEFORE harness.abort() so handleInputCancelled never clobbers them
    for (const paused of matching) {
      const pendingInputs = this.host.ctx.storage.sql
        .exec<{ id: string; tool_call_id: string; prompt_json: string | null }>(
          `SELECT id, tool_call_id, prompt_json FROM inputs WHERE run_id = ?1 AND status = 'pending'`,
          paused.id,
        )
        .toArray();
      pendingByRun.set(paused.id, pendingInputs);
      this.host.ctx.storage.sql.exec(
        `UPDATE inputs SET status = 'superseded' WHERE run_id = ?1 AND status = 'pending'`,
        paused.id,
      );
      await this.stopActiveTrackerForAbort(paused.id);
    }

    await this.ensureStarted();
    await this.harness.abort({ session: ROOT_SESSION }).catch(() => {});
    const now = Date.now();
    const closedIds: string[] = [];
    for (const paused of matching) {
      const pendingInputs = pendingByRun.get(paused.id) ?? [];
      await this.finalizeAbortedInputs(paused.id, pendingInputs, reasonText);
      for (const inp of pendingInputs) {
        this.host.recordAndBroadcastEvent(paused.id, "input_resolved", {
          id: inp.id,
          status: "superseded",
        });
      }
      this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'cancelled', error_json = ?1, ended_at = ?2 WHERE id = ?3 AND status = 'input_required'`,
        JSON.stringify({ code: "superseded", message: "Superseded by a new message" }),
        now,
        paused.id,
      );
      closedIds.push(paused.id);
      this.host.recordAndBroadcastEvent(paused.id, "run_cancelled", {
        runId: paused.id,
        code: "superseded",
      });
      this.host.notifyRunWaiters(paused.id);
    }
    return closedIds;
  }

  async respondToInput(
    inputRow: {
      id: string;
      run_id: string;
      tool_call_id: string;
      kind: "approval" | "question";
      status: string;
      prompt_json: string | null;
      pending_turn_json: string | null;
      expires_at: number;
    },
    body?: { approved?: boolean; answer?: unknown; wait?: boolean; actor?: string },
    trustedResponder = false,
  ): Promise<RunRecord> {
    const parsedMeta = inputRow.pending_turn_json ? JSON.parse(inputRow.pending_turn_json) : null;
    if (!isPiPendingInputMetadata(parsedMeta)) {
      throw new ApiError(500, "missing_turn_state", "Pi task state missing for pending input");
    }

    if (body?.approved !== undefined && typeof body.approved !== "boolean") {
      throw new ApiError(400, "invalid_approval", "The approval decision must be a boolean");
    }
    if (inputRow.kind === "approval" && body?.approved === undefined) {
      throw new ApiError(400, "invalid_approval", "Approve or decline the tool explicitly");
    }
    const approved = body?.approved ?? true;
    if (parsedMeta.mcpInput && !trustedResponder) {
      throw new ApiError(403, "forbidden", "A tenant credential must respond to signed tool inputs");
    }
    if (
      approved &&
      parsedMeta.mcpInput?.mode === "form" &&
      (!body?.answer || typeof body.answer !== "object" || Array.isArray(body.answer))
    ) {
      throw new ApiError(400, "invalid_approval", "Answer the tool form with an object");
    }

    const answeredAt = Date.now();
    const newStatus = approved ? "answered" : "denied";
    this.host.ctx.storage.sql.exec(
      `UPDATE inputs SET status = ?1, answer_json = ?2 WHERE id = ?3`,
      newStatus,
      JSON.stringify(body?.answer ?? approved),
      inputRow.id,
    );
    this.host.recordAndBroadcastEvent(inputRow.run_id, "input_resolved", {
      id: inputRow.id,
      status: newStatus,
    });

    await this.ensureStarted();
    const cfg = this.host.getConfig();
    await this.refreshModels(cfg);
    await this.ensureRoot(cfg);
    await this.ensureMcpExtensionReady(cfg);

    const tenantStub = getTenantStub(this.host.env, cfg.tenantId);

    // Re-attach or resume tracker for this run (handles both in-memory & post-eviction resume!)
    let tracker = this.activeTracker;
    if (!tracker || tracker.runId !== inputRow.run_id || tracker.settled) {
      const runRow = this.host.ctx.storage.sql.exec<ActiveRunRow>(
        `SELECT id, status, actor, output_schema_json, spend_limit_usd, baseline_entry_id, pi_progress_json
         FROM runs WHERE id = ?1 LIMIT 1`,
        inputRow.run_id,
      ).one();
      tracker = this.rehydrateTracker(runRow);
      tracker.pausedForInput = false;
      this.activeTracker = tracker;
      if (this.host.hasEventSubscribers()) {
        await this.startWatchForTracker(tracker);
      }
      this.trackSubmissionSettlement(tracker);
    } else {
      tracker.pausedForInput = false;
      if (!tracker.watchHandle && this.host.hasEventSubscribers()) {
        await this.startWatchForTracker(tracker);
      }
      if (!tracker.watchPromise) {
        this.trackSubmissionSettlement(tracker);
      }
    }

    if (!tracker.slotAcquired) {
      await tenantStub.acquireSlot(inputRow.run_id, cfg.id);
      tracker.slotAcquired = true;
    }

    this.host.setActiveRunId(inputRow.run_id);
    this.host.ctx.storage.sql.exec(`UPDATE runs SET status = 'running' WHERE id = ?1`, inputRow.run_id);
    this.host.recordAndBroadcastEvent(inputRow.run_id, "run_resumed", {
      runId: inputRow.run_id,
      inputId: inputRow.id,
    });

    const wait = body?.wait !== undefined ? Boolean(body.wait) : true;
    const settlement = wait ? this.host.waitForRunSettlement(inputRow.run_id) : undefined;

    await this.harness.signal(
      parsedMeta.piTaskId as TaskId,
      HumanInputSignal,
      inputRow.id,
      {
        approved,
        ...(body?.answer !== undefined ? { answer: body.answer as import("@earendil-works/chord/json").JsonValue } : {}),
        action: approved ? "accept" : "decline",
        ...(body?.actor ? { actor: body.actor } : {}),
        at: answeredAt,
      },
    );

    if (!wait) {
      return this.host.materializeRunRecord(inputRow.run_id);
    }
    return settlement!;
  }

  async abortRuns(body?: { keepQueued?: boolean; supersedeInputs?: boolean }): Promise<{
    aborted: true;
    cancelledRunIds: string[];
  }> {
    const cancelledRunIds: string[] = [];
    const inputStatus = body?.supersedeInputs ? "superseded" : "cancelled";
    const reasonText = body?.supersedeInputs
      ? "Not answered: the user sent a new message instead (next)."
      : "Cancelled by the application before anyone answered.";
    const errorObj = body?.supersedeInputs
      ? { code: "superseded", message: "Superseded by a new message" }
      : { code: "cancelled", message: "Cancelled via abort" };

    const activeOrPaused = this.host.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM runs WHERE status IN ('running', 'input_required')`,
      )
      .toArray();

    const pendingByRun = new Map<
      string,
      Array<{ id: string; tool_call_id: string; prompt_json: string | null }>
    >();

    // Update pending inputs BEFORE harness.abort() so handleInputCancelled never clobbers 'superseded'
    for (const row of activeOrPaused) {
      const pendingInputs = this.host.ctx.storage.sql
        .exec<{ id: string; tool_call_id: string; prompt_json: string | null }>(
          `SELECT id, tool_call_id, prompt_json FROM inputs WHERE run_id = ?1 AND status = 'pending'`,
          row.id,
        )
        .toArray();
      pendingByRun.set(row.id, pendingInputs);
      this.host.ctx.storage.sql.exec(
        `UPDATE inputs SET status = ?1 WHERE run_id = ?2 AND status = 'pending'`,
        inputStatus,
        row.id,
      );
    }

    const stoppedRunId = await this.stopActiveTrackerForAbort();
    if (stoppedRunId) cancelledRunIds.push(stoppedRunId);

    await this.ensureStarted();
    if (body?.keepQueued && this.activeTracker) {
      await this.harness.abort({ session: ROOT_SESSION, operationId: this.activeTracker.runId }).catch(() => {});
    } else {
      await this.harness.abort({ session: ROOT_SESSION }).catch(() => {});
    }

    const now = Date.now();
    for (const row of activeOrPaused) {
      if (!cancelledRunIds.includes(row.id)) cancelledRunIds.push(row.id);
      const pendingInputs = pendingByRun.get(row.id) ?? [];
      await this.finalizeAbortedInputs(row.id, pendingInputs, reasonText);
      for (const inp of pendingInputs) {
        this.host.recordAndBroadcastEvent(row.id, "input_resolved", {
          id: inp.id,
          status: inputStatus,
        });
      }
      const res = this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'cancelled', error_json = ?1, ended_at = ?2 WHERE id = ?3 AND status IN ('running', 'input_required')`,
        JSON.stringify(errorObj),
        now,
        row.id,
      );
      if (res.rowsWritten > 0) {
        this.host.recordAndBroadcastEvent(row.id, "run_cancelled", { runId: row.id });
      }
      this.host.notifyRunWaiters(row.id);
    }

    if (!body?.keepQueued) {
      const queuedRows = this.host.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM runs WHERE status = 'queued'`)
        .toArray();
      for (const qr of queuedRows) {
        if (!cancelledRunIds.includes(qr.id)) cancelledRunIds.push(qr.id);
        this.host.ctx.storage.sql.exec(
          `UPDATE runs SET status = 'cancelled', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
          JSON.stringify(errorObj),
          now,
          qr.id,
        );
        this.host.recordAndBroadcastEvent(qr.id, "run_cancelled", { runId: qr.id });
        this.host.notifyRunWaiters(qr.id);
      }
    }

    return { aborted: true, cancelledRunIds };
  }

  async getIdleCompactionState(
    _cfg?: AgentConfig,
  ): Promise<{ latestSeq: number; latestAt: number; activeTokens: number } | null> {
    if (!this.rootReady && !this.hasPiRootConversation()) return null;
    await this.ensureStarted();
    const conv = await this.getRootConversation();
    if (!conv) return null;

    const latest = await this.getLatestMessageMeta();
    if (!latest) return null;

    // Exact pi-durable estimateContext() logic: measured assistant usage after view.head +
    // estimateMessageTokens() for any messages after it.
    const view = await conv.context(BG);
    let measured: AssistantMessage | undefined;
    const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
    for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
      const entry = view.entries[index]!;
      if (entry.id <= after) continue;
      const contrib = view.contributions[index] ?? [];
      for (let j = contrib.length - 1; j >= 0; j--) {
        const msg = contrib[j]!;
        if (msg.role === "assistant" && calculateContextTokens(msg.usage) > 0) {
          measured = msg;
          break;
        }
      }
    }
    const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
    let activeTokens = measured === undefined ? 0 : calculateContextTokens(measured.usage);
    for (const msg of view.messages.slice(from)) {
      activeTokens += estimateMessageTokens(msg);
    }

    return {
      latestSeq: latest.seq,
      latestAt: latest.createdAt,
      activeTokens,
    };
  }

  async runIdleCompaction(cfg: AgentConfig, latestAt: number): Promise<boolean> {
    const idleCfg = cfg.compactOnIdle;
    if (!idleCfg?.enabled) return false;

    await this.ensureStarted();
    await this.refreshModels(cfg);
    await this.ensureRoot(cfg);
    await this.ensureMcpExtensionReady(cfg);

    const conv = await this.getRootConversation();
    if (!conv) return false;

    const nextChange = this.buildAgentChange(cfg);
    if (!this.lastAppliedAgentConfigFp) {
      await conv.configure(nextChange, BG);
      this.lastAppliedAgentConfigFp = this.agentChangeFingerprint(nextChange);
    }

    const view = await conv.context(BG);
    const start = view.head === undefined ? 0 : 1;
    const activeEntries = view.entries.slice(start);
    const activeContributions = view.contributions.slice(start);

    let estimatedActiveTokens = 0;
    let firstNonSystemEntryTokens: number | null = null;
    const contentEntries: EntryRecord[] = [];
    for (let i = 0; i < activeEntries.length; i++) {
      const entry = activeEntries[i]!;
      const msgs = activeContributions[i] ?? [];
      let entryTokens = 0;
      for (const m of msgs) {
        if (m.role !== "system") {
          entryTokens += estimateMessageTokens(m);
        }
      }
      estimatedActiveTokens += entryTokens;
      if (entryTokens > 0 && firstNonSystemEntryTokens === null) {
        firstNonSystemEntryTokens = entryTokens;
      }
      if (isUserContentEntry(entry) || AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
        contentEntries.push(entry);
      }
    }
    if (contentEntries.length === 0) return false;

    const keepRecentTokens =
      idleCfg.keepRecentTokens ?? DEFAULT_COMPACT_ON_IDLE_KEEP_RECENT_TOKENS;
    const tailTokensAfterOldest =
      firstNonSystemEntryTokens !== null
        ? estimatedActiveTokens - firstNonSystemEntryTokens
        : 0;
    if (tailTokensAfterOldest <= 0) return false;

    const effectiveKeepRecentTokens = Math.min(keepRecentTokens, tailTokensAfterOldest);
    const pi = await this.harness.pi();
    const prevHeadId = view.head ? Number(view.head.id) : 0;

    await conv.configure(
      { compaction: { enabled: true, keepRecentTokens: effectiveKeepRecentTokens } },
      BG,
    );
    try {
      const taskId = await conv.compact(undefined, BG);
      const settled = await pi.waitForTask(taskId, BG);
      if (settled.state.status === "terminal" && settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result as
          | { entryId?: EntryId; submissionId?: SubmissionId }
          | undefined;
        if (result?.submissionId !== undefined) {
          const sub = await pi.submission(result.submissionId, BG);
          await sub?.wait(BG);
        }
        if (result?.entryId !== undefined || result?.submissionId !== undefined) {
          let compEntry: EntryRecord | undefined;
          let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
          for (;;) {
            const page = await conv.entries({ order: "descending" }, 16, cursor, BG);
            compEntry =
              result?.entryId !== undefined
                ? page.items.find((e) => Number(e.id) === Number(result.entryId))
                : page.items.find((e) => CompactionEntry.is(e));
            if (compEntry || !page.next) break;
            cursor = page.next;
          }
          if (compEntry && Number(compEntry.id) > prevHeadId) {
            const headId = Number(compEntry.head ?? compEntry.id);
            const compactedCount = contentEntries.filter((e) => Number(e.id) < headId).length;
            if (compactedCount > 0) {
              this.host.recordAndBroadcastEvent(null, "context_compacted", {
                upToSeq: headId,
                compactedCount,
                reason: "idle",
                idleSeconds: Math.max(0, Math.round((Date.now() - latestAt) / 1000)),
              });
              return true;
            }
          }
        }
      } else if (settled.state.status === "terminal" && settled.state.outcome.status === "failed") {
        console.warn("Idle alarm compaction failed", {
          agentId: cfg.id,
          error: settled.state.outcome.error,
        });
      }
      return false;
    } finally {
      await conv.configure({ compaction: null }, BG).catch(() => {});
    }
  }

  async compactHistory(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ summary: string; upToSeq: number; compactedCount: number }> {
    const cfg = this.host.getConfig();
    await this.refreshModels(cfg);
    await this.ensureRoot(cfg);

    const pi = await this.harness.pi();
    const conv = await this.getRootConversation();
    if (!conv) {
      return { summary: "", upToSeq: 0, compactedCount: 0 };
    }

    const activeEntries = await this.harness.session(ROOT_SESSION).messages();
    const contentEntries = activeEntries.filter(
      (e) => isUserContentEntry(e) || AssistantEntry.is(e) || ToolResultEntry.is(e),
    );
    const keepLast = Math.max(0, Math.trunc(body?.keepLast ?? 0));

    if (body?.summary?.trim()) {
      const summary = body.summary.trim();
      let safeCutIdx = Math.max(0, contentEntries.length - keepLast);
      while (safeCutIdx > 0 && ToolResultEntry.is(contentEntries[safeCutIdx]!)) {
        safeCutIdx--;
      }
      const firstKept = contentEntries[safeCutIdx];
      const compactedCount = safeCutIdx;
      const upToSeq =
        safeCutIdx > 0
          ? Number(contentEntries[safeCutIdx - 1]!.id)
          : Number(contentEntries.at(-1)?.id ?? 0);

      const sub = await conv.submit(
        {
          type: "write",
          entry: {
            kind: CompactionEntry.kind,
            head: firstKept ? firstKept.id : "self",
            model: [
              {
                role: "user",
                content: wrapCompactionSummary(summary),
                timestamp: Date.now(),
              },
            ],
            data: { reason: "manual" },
          },
        },
        BG,
      );
      await sub.wait(BG);

      this.host.recordAndBroadcastEvent(null, "context_compacted", {
        upToSeq,
        compactedCount,
      });
      return { summary, upToSeq, compactedCount };
    }

    if (contentEntries.length === 0) {
      return { summary: "", upToSeq: 0, compactedCount: 0 };
    }

    // Run native pi-durable CompactionTask, computing keepRecentTokens from `keepLast`
    let keepRecentTokens = 0;
    if (keepLast > 0) {
      let cutIdx = Math.max(0, contentEntries.length - keepLast);
      while (cutIdx > 0 && ToolResultEntry.is(contentEntries[cutIdx]!)) {
        cutIdx--;
      }
      keepRecentTokens = contentEntries
        .slice(cutIdx)
        .reduce(
          (sum, e) => sum + (e.model ?? []).reduce((s, m) => s + estimateMessageTokens(m), 0),
          0,
        );
    }
    await conv.configure({ compaction: { enabled: true, keepRecentTokens } }, BG);

    try {
      const taskId = await conv.compact(undefined, BG);
      const settled = await pi.waitForTask(taskId, BG);
      if (settled.state.status === "terminal" && settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result as
          | { entryId?: EntryId; submissionId?: SubmissionId }
          | undefined;
        if (result?.submissionId !== undefined) {
          const sub = await pi.submission(result.submissionId, BG);
          await sub?.wait(BG);
        }
        if (result?.entryId !== undefined || result?.submissionId !== undefined) {
          let compEntry: EntryRecord | undefined;
          let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
          for (;;) {
            const page = await conv.entries({ order: "descending" }, 16, cursor, BG);
            compEntry =
              result?.entryId !== undefined
                ? page.items.find((e) => Number(e.id) === Number(result.entryId))
                : page.items.find((e) => CompactionEntry.is(e));
            if (compEntry || !page.next) break;
            cursor = page.next;
          }
          if (compEntry) {
            const msg = compEntry.model?.[0];
            const rawText =
              msg && msg.role === "user"
                ? typeof msg.content === "string"
                  ? msg.content
                  : msg.content
                      .filter((c): c is TextContent => c.type === "text")
                      .map((c) => c.text)
                      .join("\n")
                : "";
            const summary = unwrapCompactionSummary(rawText);
            const headId = Number(compEntry.head ?? compEntry.id);
            const compactedCount = contentEntries.filter((e) => Number(e.id) < headId).length;
            const upToSeq = headId;
            this.host.recordAndBroadcastEvent(null, "context_compacted", {
              upToSeq,
              compactedCount,
            });
            return { summary, upToSeq, compactedCount };
          }
        }
      }
      return { summary: "", upToSeq: 0, compactedCount: 0 };
    } finally {
      await conv.configure({ compaction: null }, BG).catch(() => {});
    }
  }

  async resetContext(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ ok: true; upToSeq: number; summary: string }> {
    const cfg = this.host.getConfig();
    await this.ensureRoot(cfg);

    const summary = body?.summary?.trim() ?? "";
    const conv = await this.getRootConversation();
    const tailPage = conv ? await conv.entries({ order: "descending" }, 1, undefined, BG) : null;
    const upToSeq = Number(tailPage?.items[0]?.id ?? 0);

    await this.harness.session(ROOT_SESSION).reset(summary || undefined);
    this.host.recordAndBroadcastEvent(null, "context_reset", { upToSeq });
    return { ok: true, upToSeq, summary };
  }

  private hasPiRootConversation(): boolean {
    const hasTable = this.host.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pi_conversations' LIMIT 1`,
      )
      .toArray();
    if (hasTable.length === 0) return false;
    const rows = this.host.ctx.storage.sql
      .exec<{ id: number }>(`SELECT id FROM pi_conversations WHERE id = 1 LIMIT 1`)
      .toArray();
    return rows.length > 0;
  }

  async listAllEntries(): Promise<EntryRecord[]> {
    await this.ensureStarted();
    const conv = await this.getRootConversation();
    if (!conv) return [];
    const all: EntryRecord[] = [];
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    for (;;) {
      const page = await conv.entries({ order: "ascending" }, 256, cursor, BG);
      all.push(...page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    return all;
  }

  private async recordRunRepoCommit(tracker: ActiveRunTracker, cfg: AgentConfig): Promise<void> {
    const targetEntryId = tracker.lastMessageEntryId;
    if (targetEntryId === null) return;
    let commit = tracker.lastRepoCommit;
    if (!commit && cfg.repoId) {
      commit =
        (
          await getTenantStub(this.host.env, cfg.tenantId)
            .getRepo(cfg.repoId)
            .catch(() => null)
        )?.commit || null;
    }
    if (commit) {
      this.recordEntryMeta(targetEntryId, tracker.runId, undefined, commit);
    }
  }

  private recordEntryMeta(
    entryId: number,
    runId: string | null,
    meta?: Record<string, unknown>,
    repoCommit?: string | null,
  ): void {
    try {
      this.host.ctx.storage.sql.exec(
        `INSERT INTO pi_entry_meta (entry_id, run_id, meta_json, repo_commit)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(entry_id) DO UPDATE SET
           run_id = COALESCE(pi_entry_meta.run_id, excluded.run_id),
           meta_json = COALESCE(excluded.meta_json, pi_entry_meta.meta_json),
           repo_commit = COALESCE(excluded.repo_commit, pi_entry_meta.repo_commit)`,
        entryId,
        runId,
        meta ? JSON.stringify(meta) : null,
        repoCommit ?? null,
      );
    } catch {
      // Table may not exist in minimal unit harnesses
    }
  }

  private loadEntryMetaMap(): Map<number, import("./migrate.ts").PiEntryMetadata> {
    const out = new Map<number, import("./migrate.ts").PiEntryMetadata>();
    try {
      const rows = this.host.ctx.storage.sql
        .exec<{
          entry_id: number;
          run_id: string | null;
          meta_json: string | null;
          repo_commit: string | null;
        }>(`SELECT entry_id, run_id, meta_json, repo_commit FROM pi_entry_meta`)
        .toArray();
      for (const r of rows) {
        out.set(Number(r.entry_id), {
          runId: r.run_id,
          ...(r.meta_json ? { meta: JSON.parse(r.meta_json) as Record<string, unknown> } : {}),
          ...(r.repo_commit ? { repoCommit: r.repo_commit } : {}),
        });
      }
    } catch {
      // Table absent
    }
    return out;
  }

  async getHistory(opts?: {
    after?: number;
    before?: number;
    limit?: number;
  }): Promise<MappedHistoryResult | null> {
    if (!this.rootReady && !this.hasPiRootConversation()) {
      return null;
    }
    const sql = this.host.ctx.storage.sql;
    if (!this.historyIndexesReady) {
      ensurePiHistoryIndexes(sql);
      this.historyIndexesReady = true;
    }
    return readPiHistoryPage(sql, opts);
  }

  async getMessageCount(): Promise<number | null> {
    if (!this.rootReady && !this.hasPiRootConversation()) {
      return null;
    }
    try {
      const row = this.host.ctx.storage.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM pi_entries
           WHERE conversation_id = 1
             AND json_extract(record, '$.kind') IN ('pi.user', 'camelrun.user', 'pi.assistant', 'pi.tool-result')`,
        )
        .toArray()[0];
      if (row) return Number(row.cnt ?? 0);
    } catch {
      // Fallback to paginated count below if schema differs in a test harness
    }
    await this.ensureStarted();
    const conv = await this.getRootConversation();
    if (!conv) return 0;
    let count = 0;
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    for (;;) {
      const page = await conv.entries({ order: "ascending" }, 256, cursor, BG);
      for (const e of page.items) {
        if (isUserContentEntry(e) || AssistantEntry.is(e) || ToolResultEntry.is(e)) count++;
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return count;
  }

  async exportEntriesUpTo(
    atSeq?: number,
    activeRunId?: string | null,
  ): Promise<{
    entries: EntryRecord[];
    targetSeq: number;
    entryMeta: Array<{
      entryId: number;
      runId: string | null;
      meta?: Record<string, unknown>;
      repoCommit?: string | null;
    }>;
    repoCommit: string | null;
  }> {
    await this.ensureRoot();
    const all = await this.listAllEntries();
    const metaMap = this.loadEntryMetaMap();
    const isContent = (e: EntryRecord) =>
      isUserContentEntry(e) || AssistantEntry.is(e) || ToolResultEntry.is(e);

    let targetSeq: number;
    let endIdx: number;
    if (atSeq !== undefined) {
      if (!Number.isInteger(atSeq) || atSeq < 0) {
        throw new ApiError(404, "fork_point_invalid", `Fork target '${atSeq}' not found in agent history`);
      }
      const matchIdx = all.findIndex((e) => Number(e.id) === atSeq && isContent(e));
      if (matchIdx < 0) {
        throw new ApiError(404, "fork_point_invalid", `Fork target '${atSeq}' not found in agent history`);
      }
      targetSeq = atSeq;
      endIdx = matchIdx;
    } else {
      targetSeq = Number(all.at(-1)?.id ?? 0);
      endIdx = all.length - 1;
    }

    if (activeRunId) {
      let activeRunStartSeq: number | null = null;
      for (const e of all) {
        const entryRunId =
          (CamelRunUserEntry.is(e) ? ((e.data as { runId?: unknown } | undefined)?.runId as string | undefined) : undefined) ??
          metaMap.get(Number(e.id))?.runId ??
          null;
        if (entryRunId === activeRunId) {
          activeRunStartSeq = Number(e.id);
          break;
        }
      }
      if (atSeq === undefined || (activeRunStartSeq !== null && targetSeq >= activeRunStartSeq)) {
        throw new ApiError(409, "fork_point_running", "Cannot fork a turn that is still running");
      }
    }

    // Keep any matching tool results right after an assistant tool_call (or peer tool results in the same batch)
    // so the forked conversation never ends with an unanswered tool call.
    if (endIdx >= 0 && endIdx < all.length) {
      let anchorIdx = endIdx;
      while (anchorIdx > 0 && ToolResultEntry.is(all[anchorIdx]!)) {
        anchorIdx--;
      }
      const anchor = all[anchorIdx];
      if (anchor && AssistantEntry.is(anchor)) {
        const msg = anchor.model?.[0];
        const callIds = new Set<string>();
        if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "toolCall" && typeof block.id === "string" && block.id) {
              callIds.add(block.id);
            }
          }
        }
        if (callIds.size > 0) {
          while (endIdx + 1 < all.length && ToolResultEntry.is(all[endIdx + 1]!)) {
            const tr = all[endIdx + 1]!.model?.[0];
            if (tr && tr.role === "toolResult" && callIds.has(tr.toolCallId)) {
              endIdx++;
            } else {
              break;
            }
          }
          targetSeq = Number(all[endIdx]!.id);
        }
      }
    }

    const entries = endIdx >= 0 ? all.slice(0, endIdx + 1) : [];
    const entryMeta: Array<{
      entryId: number;
      runId: string | null;
      meta?: Record<string, unknown>;
      repoCommit?: string | null;
    }> = [];
    let repoCommit: string | null = null;
    for (const e of entries) {
      const m = metaMap.get(Number(e.id));
      if (m) {
        if (m.repoCommit) repoCommit = m.repoCommit;
        entryMeta.push({
          entryId: Number(e.id),
          runId: m.runId,
          ...(m.meta ? { meta: m.meta } : {}),
          ...(m.repoCommit ? { repoCommit: m.repoCommit } : {}),
        });
      }
    }
    return { entries, targetSeq, entryMeta, repoCommit };
  }

  async seedForkEntries(
    cfg: AgentConfig,
    entries: EntryRecord[],
    entryMeta?: Array<{
      entryId: number;
      runId: string | null;
      meta?: Record<string, unknown>;
      repoCommit?: string | null;
    }>,
  ): Promise<void> {
    await this.ensureStarted();
    await this.refreshModels(cfg);
    await this.ensureExtensionsInstalled(cfg);
    const initialChange = this.buildAgentChange(cfg);
    let idMap = new Map<number, number>();
    await this.harness.root({
      agent: initialChange,
      init: async (tx, convId) => {
        if (entries.length > 0) {
          idMap = await copyPiEntriesToConversation(tx, convId, entries);
        }
      },
    });
    if (entryMeta?.length) {
      for (const m of entryMeta) {
        const mappedId = idMap.get(m.entryId);
        if (mappedId !== undefined) {
          this.recordEntryMeta(mappedId, m.runId, m.meta, m.repoCommit);
        }
      }
    }
    this.lastAppliedAgentConfigFp = this.agentChangeFingerprint(initialChange);
    this.rootReady = true;
  }

  async syncModelChange(cfg: AgentConfig): Promise<void> {
    if (!this.rootReady && !this.hasPiRootConversation()) return;
    await this.ensureStarted();
    await this.refreshModels(cfg);
    const modelRef = parsePiModelRef(cfg.model, this.host.env);
    await this.harness.session(ROOT_SESSION).setModel({
      provider: modelRef.provider,
      id: modelRef.modelId,
    });
    this.lastAppliedAgentConfigFp = "";
  }

  async appendPassiveNote(text: string, meta?: Record<string, unknown>): Promise<void> {
    await this.ensureRoot();
    const conv = await this.getRootConversation();
    if (!conv) return;
    const data: JsonObject = {
      runId: null,
      ...(meta ? { meta: JSON.parse(JSON.stringify(meta)) } : {}),
    };
    const sub = await conv.submit(
      {
        type: "write",
        entry: {
          kind: CamelRunUserEntry.kind,
          model: [{ role: "user", content: text, timestamp: Date.now() }],
          data,
        },
      },
      BG,
    );
    await sub.wait(BG);
  }

  async getLatestMessageMeta(): Promise<{ seq: number; createdAt: number } | null> {
    if (!this.rootReady && !this.hasPiRootConversation()) return null;
    await this.ensureStarted();
    const conv = await this.getRootConversation();
    if (!conv) return null;
    let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
    for (;;) {
      const page = await conv.entries({ order: "descending" }, 16, cursor, BG);
      for (const e of page.items) {
        if (isUserContentEntry(e) || AssistantEntry.is(e) || ToolResultEntry.is(e)) {
          const msg = e.model?.[0] as { timestamp?: number } | undefined;
          return { seq: Number(e.id), createdAt: msg?.timestamp || Date.now() };
        }
      }
      if (!page.next) break;
      cursor = page.next;
    }
    return null;
  }

  async executeBashStep(
    command: string,
    opts?: Record<string, unknown>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; commit?: string; billableMs?: number }> {
    const execEnv = this.buildExecutionEnv();
    const timeoutSeconds =
      typeof opts?.timeoutSeconds === "number" && opts.timeoutSeconds > 0
        ? opts.timeoutSeconds
        : 60;
    let stdout = "";
    let stderr = "";
    const res = await execEnv.exec(
      command,
      {
        timeout: timeoutSeconds,
        ...(typeof opts?.cwd === "string" ? { cwd: opts.cwd } : {}),
        onOutput: (chunk, _ctx, meta) => {
          if (meta?.stream === "stderr") stderr += chunk;
          else stdout += chunk;
        },
      },
      BG,
    );
    if (!res.ok) {
      throw new Error(res.error.message || "Bash command failed");
    }
    return {
      exitCode: res.value.exitCode,
      stdout,
      stderr,
    };
  }

  async executeCommitStep(message: string): Promise<{ ref: string; commit: string }> {
    const cfg = this.host.getConfig();
    const { lineage, branch } = await this.host.ensureAgentRepository();
    const cfs = new CamelFsClient(this.host.env, cfg.tenantId);
    const refsRes = await cfs.listRefs(lineage, branch);
    const head = refsRes.refs.find((r) => r.name === branch) ?? refsRes.refs[0];
    if (!head) {
      throw new Error(`Branch '${branch}' not found`);
    }
    const tagName = message.trim()
      ? message.trim().replace(/^refs\/checkpoints\//, "").replace(/[^A-Za-z0-9._/-]+/g, "-")
      : `cp-${Date.now()}`;
    const checkpointRef = tagName.startsWith("refs/") ? tagName : `refs/checkpoints/${tagName}`;
    return cfs.updateRef(lineage, {
      ref: checkpointRef,
      commit: head.commit,
      holder: cfg.id,
    });
  }

  async executeRegisteredTool(
    toolName: string,
    args: Record<string, unknown>,
    callId = randomId("tool", 6),
  ): Promise<unknown> {
    const cfg = this.host.getConfig();
    await this.ensureExtensionsInstalled(cfg);
    const snap = this.registry.snapshot();
    const entry = [...snap.tools()].find((t) => t.tool.name === toolName);
    if (!entry) {
      throw new ApiError(404, "unknown_tool", `Tool '${toolName}' is not registered on this agent`);
    }
    const execEnv = this.buildExecutionEnv();
    const fakeApi = {
      callId,
      conversationId: ROOT_CONVERSATION_ID,
      taskId: 0 as TaskId,
      env: execEnv,
      now: () => Date.now(),
      memo: async <T>(_key: string, val: T) => val,
      readSignal: async () => undefined,
      snapshot: async () => undefined,
    };
    const out = await entry.tool.execute(args as never, fakeApi as never, BG);
    if (out && typeof out === "object" && "sleep" in out) {
      throw new ApiError(409, "tool_requires_input", `Tool '${toolName}' requires interactive input`);
    }
    const result = out as ToolExecutionResult;
    if (result.structuredOutput !== undefined) {
      return result.structuredOutput;
    }
    const text = (result.output ?? [])
      .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async consolidateDream(): Promise<{
    ok: boolean;
    path: string;
    commit: string;
    summary: string;
  }> {
    const cfg = this.host.getConfig();
    const { repoId, lineage, branch } = await this.host.ensureAgentRepository();
    const cfs = new CamelFsClient(this.host.env, cfg.tenantId);

    let existingMemory = "";
    try {
      const readRes = await cfs.read(lineage, { at: branch, path: "MEMORY.md" });
      if (readRes.content) existingMemory = readRes.content;
    } catch {
      // MEMORY.md doesn't exist yet
    }

    const history = (await this.getHistory({ before: Number.MAX_SAFE_INTEGER, limit: 100 })) ?? {
      messages: [],
      compaction: null,
      nextAfter: 0,
    };
    const lines: string[] = [];
    if (history.compaction?.summary) {
      lines.push(`Prior summary:\n${history.compaction.summary}`);
    }
    for (const m of history.messages.slice(-80)) {
      const text = typeof m.content.text === "string" ? m.content.text : JSON.stringify(m.content);
      if (text) lines.push(`[${m.role}]: ${text.slice(0, 3_000)}`);
    }
    const transcript = lines.join("\n\n").slice(-160_000);

    const { isByok, prefetchedProvider } = await resolveTenantByokProvider(
      this.host.env,
      cfg.tenantId,
      cfg.model,
      undefined,
      cfg.keyScope ?? null,
    );
    const prefetchedCredentials = prefetchedProvider
      ? { [parsePiModelRef(cfg.model, this.host.env).provider]: prefetchedProvider.credentials }
      : undefined;

    const completion = await completePiModel({
      env: this.host.env,
      tenantId: cfg.tenantId,
      model: cfg.model,
      keyScope: cfg.keyScope ?? null,
      prefetchedCredentials,
      instructions: [
        "Consolidate durable lessons, user preferences, and repository architecture notes into clean Markdown for /workspace/MEMORY.md.",
        existingMemory ? `Existing MEMORY.md:\n${existingMemory}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      messages: [
        {
          role: "user",
          content: transcript || "Consolidate agent memory.",
          timestamp: Date.now(),
        },
      ],
    });

    const finalDoc = completion.text.trim() || "# Consolidated Agent Memory\n";
    const writeOut = await cfs.write(lineage, {
      ref: branch,
      holder: cfg.id,
      author: `agent:${cfg.id}`,
      message: "dream: consolidate MEMORY.md",
      puts: [{ path: "MEMORY.md", content: finalDoc + "\n", mode: 0o644 }],
    });

    const tenantStub = getTenantStub(this.host.env, cfg.tenantId);
    const cacheWriteTokens = completion.message.usage?.cacheWrite ?? 0;
    const dreamCostUsd = isByok
      ? 0
      : calculatePiCostUsd(
          cfg.model,
          completion.inputTokens,
          completion.outputTokens,
          0,
          completion.cacheReadTokens,
          cacheWriteTokens,
        );
    if (completion.inputTokens > 0 || completion.outputTokens > 0 || dreamCostUsd > 0) {
      await tenantStub
        .settleUsage({
          refId: `dream:${cfg.id}:${writeOut.commit}`,
          model: cfg.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          cacheReadTokens: completion.cacheReadTokens,
          vmMs: 0,
          costUsd: dreamCostUsd,
          note: `Dream ${cfg.key} (${cfg.id})`,
          agentId: cfg.id,
          ...(isByok ? { byok: true } : {}),
        })
        .catch(() => {});
    }

    void tenantStub.updateRepoCommit(repoId, writeOut.commit).catch(() => {});

    this.host.recordAndBroadcastEvent(null, "dream_completed", {
      path: "MEMORY.md",
      commit: writeOut.commit,
    });

    return {
      ok: true,
      path: "MEMORY.md",
      commit: writeOut.commit,
      summary: finalDoc,
    };
  }
}

export type { LifecycleJobContext };
