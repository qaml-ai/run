import { Buffer } from "node:buffer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type AgentChange,
  type ConversationWatch,
  type EntryId,
  type EntryRecord,
  type Extension,
  type LiveState,
  type Registry,
  type TaskId,
  type ToolExecutionResult,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { CodemodeGlobal } from "@earendil-works/pi-durable/codemode";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { openPiSessionStore, PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import type { DurableObject } from "cloudflare:workers";
import { CamelFsClient, normalizeRepoPath } from "../camelfs.ts";
import { randomId } from "../crypto.ts";
import { imageHeader } from "../lib/image-header.ts";
import { consumeInfraCredit } from "../ops-metadata.ts";
import { isImageAttachment, parseRunFiles, verifyRunFiles } from "../run-files.ts";
import { toolImageKey } from "../tool-images.ts";
import { getSkillStore, type SkillRecord } from "../skills.ts";
import { getTenantStub, platformCreditReserve } from "../tenant-do.ts";
import {
  ApiError,
  emptyUsage,
  extractApiError,
  type AgentConfig,
  type AgentEventRecord,
  type Env,
  type RunFile,
  type RunRecord,
  type RunUsage,
  type StartRunHints,
  type StartRunInput,
  type StoredMessage,
  type StoredRunFile,
  type ToolCallSummary,
} from "../types.ts";
import { createCamelFsExecutionEnv } from "./camelfs-env.ts";
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
import {
  copyPiEntriesToConversation,
  importLegacyTranscriptToPi,
  mapPiEntriesToHistory,
  unwrapCompactionSummary,
  wrapCompactionSummary,
  type LegacyCompactionRow,
  type MappedHistoryResult,
} from "./migrate.ts";
import {
  buildPiModels,
  calculatePiCostUsd,
  completePiModel,
  createProviderRequestExtension,
  getAutoCompactThreshold,
  getModelContextWindow,
  parsePiModelRef,
  resolveTenantByokProvider,
} from "./models.ts";

const BG = BACKGROUND_CONTEXT;

export interface PiPendingInputMetadata {
  engine: "pi";
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
  getVmSession(branch: string): { vmId: string; leaseExpiresAt: number } | null;
  saveVmSession(branch: string, vmId: string, leaseExpiresAt: number): void;
  clearVmSession(branch: string, vmId: string): void;
  recordChildAgent(entry: {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    parentRunId: string;
    status: string;
    result: unknown;
  }): void;
  getChildAgent(idOrAgentId: string): {
    id: string;
    childAgentId: string;
    childAgentKey: string;
    status: string;
    result: unknown;
  } | null;
  hasWebSocketTool(name: string): boolean;
  invokeWebSocketTool(name: string, args: Record<string, unknown>, callId: string): Promise<unknown>;
  recordAndBroadcastEvent(
    runId: string | null,
    type: string,
    data: Record<string, unknown>,
  ): AgentEventRecord;
  enqueueAppWebhook(tenantId: string, eventType: string, payload: Record<string, unknown>): void;
  scheduleNextAlarm(): Promise<void>;
  materializeRunRecord(runId: string): RunRecord;
  waitForRunSettlement(runId: string): Promise<RunRecord>;
  notifyRunWaiters(runId: string): void;
  releaseUnusedPreacquiredHint(tenantId: string, hints?: StartRunHints): void;
  setActiveRunId(runId: string | null): void;
  getActiveRunId(): string | null;
  onRunSettled?(runId: string): void;
  runWorkflow?(body: { code: string; idempotencyKey?: string }): Promise<unknown>;
}

interface ActiveRunTracker {
  runId: string;
  actor?: string;
  requestId?: string | null;
  verifiedFiles?: StoredRunFile[];
  outputSchema: Record<string, unknown> | null;
  spendLimitUsd: number | null;
  usage: RunUsage;
  filesChanged: Set<string>;
  toolCalls: ToolCallSummary[];
  seenToolStarts: Set<string>;
  seenToolEnds: Set<string>;
  seenEntryIds: Set<number>;
  emittedGenerationAttempt: number;
  emittedPartialTextLen: number;
  lastEmittedAssistantEntryId: number;
  accumulatedText: string;
  slotAcquired: boolean;
  settled: boolean;
  pausedForInput: boolean;
  spendLimitError: { code: "spend_limit_exceeded"; message: string } | null;
  aborted: boolean;
  watchHandle: ConversationWatch | null;
  watchPromise: Promise<void> | null;
}

const FILES_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "read_file",
  "write_file",
  "edit_file",
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
      (value as { engine?: unknown }).engine === "pi" &&
      typeof (value as { piTaskId?: unknown }).piTaskId === "number",
  );
}

/**
 * Dual-engine Pi adapter owned lazily by `AgentDO`.
 *
 * Composes `Lifecycle` (`agents/lifecycle`) + `PiHarness` (`agents/harness/pi`) over
 * `openPiSessionStore(ctx.storage, { prefix: "pi_" })` so `pi_*` and `cf_agents_jobs`
 * never collide with CamelRun's legacy SQLite tables.
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
  private installedCustomFingerprint = "";
  private installedMcpFingerprint = "";
  private toolResultTextOverrides = new Map<string, string>();
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
            getOutputSchema: () => this.activeTracker?.outputSchema ?? null,
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
              const contextWindow = getModelContextWindow(cur?.model ?? cfg.model);
              const threshold = cur?.compactThresholdTokens ?? 40_000;
              const effectiveThreshold = Math.max(8_000, Math.min(threshold, contextWindow - 16_384));
              const reserveTokens = Math.max(16_384, contextWindow - effectiveThreshold);
              return {
                compaction: {
                  enabled: true,
                  keepRecentTokens: Math.min(20_000, Math.floor(effectiveThreshold / 2)),
                  reserveTokens,
                  backgroundTokens: Math.min(Math.max(reserveTokens, contextWindow - 4_096), reserveTokens + 4_096),
                },
                afterFailedRun: "keep",
              };
            },
            env: async () => this.buildExecutionEnv(),
          },
          BG,
        );
      },
      defaults: {
        maxTurns: 25,
      },
    });

    this.lifecycle.use(this.harness);
  }

  async ensureStarted(): Promise<void> {
    if (this.lifecycle.isStarted()) return;
    this.startPromise ??= this.lifecycle.start().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    await this.startPromise;
  }

  isBusy(): boolean {
    if (this.activeTracker && !this.activeTracker.settled) return true;
    return false;
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

  async steerActiveRun(prompt: string, steerRunId: string): Promise<void> {
    await this.ensureStarted();
    await this.harness.session(ROOT_SESSION).steer(prompt, { operationId: steerRunId });
  }

  async dispose(): Promise<void> {
    if (this.activeTracker?.watchHandle) {
      await this.activeTracker.watchHandle.stop().catch(() => {});
      this.activeTracker.watchHandle = null;
    }
    this.activeTracker = null;
    this.rootReady = false;
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

  private buildExecutionEnv() {
    const cfg = this.host.getConfig();
    return createCamelFsExecutionEnv({
      env: this.host.env,
      tenantId: cfg.tenantId,
      agentId: cfg.id,
      ensureRepo: () => this.host.ensureAgentRepository(),
      getResolvedSkills: () => this.getResolvedSkills(),
      onFilesChanged: (files) => this.recordFilesChanged(files),
      onRepoCommit: async (repoId, commit) => {
        await getTenantStub(this.host.env, cfg.tenantId)
          .updateRepoCommit(repoId, commit)
          .catch(() => {});
      },
      getVmSession: (branch) => this.host.getVmSession(branch),
      saveVmSession: (branch, vmId, leaseExpiresAt) =>
        this.host.saveVmSession(branch, vmId, leaseExpiresAt),
      clearVmSession: (branch, vmId) => this.host.clearVmSession(branch, vmId),
      onVmBillableMs: (billableMs) => this.recordVmBillableMs(billableMs),
    });
  }

  private recordFilesChanged(files: string[]): void {
    const tracker = this.activeTracker;
    if (!tracker) return;
    for (const f of files) tracker.filesChanged.add(f);
    this.persistTrackerProgress(tracker);
  }

  private recordVmBillableMs(billableMs: number): void {
    const tracker = this.activeTracker;
    if (!tracker || !billableMs) return;
    const cfg = this.host.getConfig();
    tracker.usage.vmMs += billableMs;
    const addedCost = calculatePiCostUsd(cfg.model, 0, 0, billableMs, 0);
    tracker.usage.costUsd = Number((tracker.usage.costUsd + addedCost).toFixed(8));
    this.persistTrackerProgress(tracker);
  }

  private persistTrackerProgress(tracker: ActiveRunTracker): void {
    this.host.ctx.storage.sql.exec(
      `UPDATE runs
       SET text = ?1, tool_calls_json = ?2, files_changed_json = ?3, usage_json = ?4
       WHERE id = ?5`,
      tracker.accumulatedText,
      JSON.stringify(tracker.toolCalls),
      JSON.stringify([...tracker.filesChanged]),
      JSON.stringify(tracker.usage),
      tracker.runId,
    );
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
    const getActiveRunId = () => this.activeTracker?.runId;
    for (const custom of cfg.tools ?? []) {
      const spec = custom;
      tools.push(
        defineTool({
          name: spec.name,
          description: spec.description || `Custom tool ${spec.name}`,
          parameters: (spec.parameters && typeof spec.parameters === "object"
            ? spec.parameters
            : { type: "object", properties: {} }) as Record<string, unknown>,
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
          await getTenantStub(host.env, cfg.tenantId)
            .updateRepoCommit(repoId, out.commit)
            .catch(() => {});
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
          getOutputSchema: () => this.activeTracker?.outputSchema ?? null,
          getPromptCacheKey: () => this.host.readConfigOrNull()?.id,
          getToolResultOverride: (callId) => this.toolResultTextOverrides.get(callId),
        }),
      );
    }

    if (!snap.extension("camelrun-billing")) {
      this.registry.install(
        createCamelRunBillingExtension({
          getSpendLimitUsd: () => {
            const limit = this.activeTracker?.spendLimitUsd;
            return limit === null || limit === undefined ? undefined : limit;
          },
          getSpentUsd: () => this.activeTracker?.usage.costUsd ?? 0,
          onSpendLimitExceeded: (ev) => {
            if (this.activeTracker) {
              this.activeTracker.spendLimitError = {
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
          includeLegacyAliases: true,
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
          onRepoCommit: async (repoId, commit) => {
            await getTenantStub(this.host.env, cfg.tenantId)
              .updateRepoCommit(repoId, commit)
              .catch(() => {});
          },
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
          onRepoCommit: async (repoId, commit) => {
            await getTenantStub(this.host.env, cfg.tenantId)
              .updateRepoCommit(repoId, commit)
              .catch(() => {});
          },
        }),
      );
    }

    if (!snap.extension("camelrun-delegate")) {
      this.registry.install(
        createCamelRunDelegateExtension({
          env: this.host.env,
          config: cfg,
          getRunId: () => this.activeTracker?.runId ?? "",
          recordChildAgent: (entry) => this.host.recordChildAgent(entry),
          getChildAgent: (id) => this.host.getChildAgent(id),
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

    const customFp = JSON.stringify(cfg.tools ?? []);
    if (customFp !== this.installedCustomFingerprint || !snap.extension("camelrun-custom-and-web")) {
      this.registry.install(this.buildCustomAndWebExtension(cfg));
      this.installedCustomFingerprint = customFp;
    }

    // Install placeholder MCP extension without eager network discovery (callers like camel-bots
    // upsert agents before activating signed MCP ACLs). Real MCP discovery happens lazily in
    // `ensureMcpExtensionReady()` right before `startRun`, `executeRun`, or `respondToInput`.
    if (!snap.extension("camelrun-mcp")) {
      this.registry.install(defineExtension({ name: "camelrun-mcp", tools: [] }));
    }
  }

  private async ensureMcpExtensionReady(cfg: AgentConfig): Promise<void> {
    const mcpFp = JSON.stringify(cfg.mcpServers ?? []);
    if (mcpFp === this.installedMcpFingerprint) return;
    if ((cfg.mcpServers ?? []).length > 0) {
      const mcpExt = await createCamelRunMcpExtension({
        env: this.host.env,
        agent: cfg,
        getRunId: () => this.activeTracker?.runId ?? "",
        getActor: () => this.activeTracker?.actor,
        onInputRequired: (ev) => this.handleInputRequired(ev),
      });
      this.registry.install(mcpExt);
    } else {
      this.registry.install(defineExtension({ name: "camelrun-mcp", tools: [] }));
    }
    this.installedMcpFingerprint = mcpFp;
  }

  private async maybeAutoCompact(cfg: AgentConfig): Promise<void> {
    const threshold = getAutoCompactThreshold(cfg.model, cfg.compactThresholdTokens);
    const activeEntries = await this.harness.session(ROOT_SESSION).messages();
    const contentEntries = activeEntries.filter(
      (e) => UserEntry.is(e) || AssistantEntry.is(e) || ToolResultEntry.is(e),
    );
    if (contentEntries.length <= 6) return;

    let totalChars = 0;
    for (const e of contentEntries) {
      totalChars += JSON.stringify(e.model ?? "").length;
    }
    const estTokens = Math.ceil(totalChars / 4);
    if (estTokens <= threshold) return;

    let cutIdx = Math.max(0, contentEntries.length - 6);
    // Never split a tool call from any of its tool results
    while (cutIdx > 0 && ToolResultEntry.is(contentEntries[cutIdx])) {
      cutIdx--;
    }
    if (cutIdx <= 0) return;

    const firstKept = contentEntries[cutIdx]!;
    const upToSeq = cutIdx;

    const transcriptLines: string[] = [];
    for (const entry of contentEntries.slice(0, cutIdx)) {
      const m = entry.model?.[0];
      if (!m) continue;
      if (m.role === "user") {
        const txt =
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        transcriptLines.push(`user: ${txt.slice(0, 600)}`);
      } else if (m.role === "assistant") {
        const txt = extractAssistantText(m);
        transcriptLines.push(`assistant: ${txt.slice(0, 600)}`);
      } else if (m.role === "toolResult") {
        const txt = m.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        transcriptLines.push(`tool(${m.toolName}): ${txt.slice(0, 400)}`);
      }
    }

    let summary = `Previous conversation summary (up to message #${upToSeq}):\n${transcriptLines.join("\n").slice(0, 1200)}`;
    try {
      const res = await completePiModel({
        env: this.host.env,
        tenantId: cfg.tenantId,
        keyScope: cfg.keyScope ?? null,
        model: cfg.model,
        instructions:
          "Summarize the prior conversation concisely, preserving key facts, decisions, file paths, and tool results.",
        messages: [
          {
            role: "user",
            content: `Summarize these ${cutIdx} messages:\n\n${transcriptLines.join("\n").slice(0, 16_000)}`,
            timestamp: Date.now(),
          },
        ],
      });
      if (res.text.trim()) {
        summary = `Previous conversation summary (up to message #${upToSeq}):\n${res.text.trim()}`;
      }
    } catch {
      // Keep deterministic transcript-snippet summary fallback
    }

    const pi = await this.harness.pi();
    const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
    if (!conv) return;

    const sub = await conv.submit(
      {
        type: "write",
        entry: {
          kind: CompactionEntry.kind,
          head: firstKept.id,
          model: [
            {
              role: "user",
              content: wrapCompactionSummary(summary),
              timestamp: Date.now(),
            },
          ],
          data: { reason: "auto" },
        },
      },
      BG,
    );
    await sub.wait(BG);

    this.host.recordAndBroadcastEvent(null, "context_compacted", {
      upToSeq,
      compactedCount: cutIdx,
    });
  }

  private buildAgentChange(cfg: AgentConfig, maxTurns?: number): AgentChange {
    const builtins = new Set(cfg.builtins ?? []);
    const customNames = new Set((cfg.tools ?? []).map((t) => t.name));
    const hasSkills = builtins.has("skills") || (cfg.skills?.length ?? 0) > 0;
    const hasMcp = (cfg.mcpServers?.length ?? 0) > 0;

    const enabledTools: ToolRegistration[] = [];
    for (const { extension, tool } of this.registry.snapshot().tools()) {
      const name = tool.name;
      if (customNames.has(name)) {
        enabledTools.push(tool);
        continue;
      }
      if (extension.name === "camelrun-mcp" && hasMcp) {
        enabledTools.push(tool);
        continue;
      }
      if (FILES_TOOL_NAMES.has(name) && builtins.has("files")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "render_image" && builtins.has("images")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "bash" && builtins.has("bash")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "codemode" && builtins.has("codemode") && this.host.env.CODEMODE_SANDBOX) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "ask_human" && builtins.has("human")) {
        enabledTools.push(tool);
        continue;
      }
      if ((name === "read_skill" || name === "search_skills") && hasSkills) {
        enabledTools.push(tool);
        continue;
      }
      if (extension.name === "camelrun-browser" && builtins.has("browser")) {
        enabledTools.push(tool);
        continue;
      }
      if (extension.name === "camelrun-delegate" && builtins.has("delegate")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "web_fetch" && builtins.has("web_fetch")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "web_search" && builtins.has("web_search")) {
        enabledTools.push(tool);
        continue;
      }
      if (name === "run_workflow" && builtins.has("workflows")) {
        enabledTools.push(tool);
        continue;
      }
    }

    const modelRef = parsePiModelRef(cfg.model, this.host.env);
    return {
      model: modelRef,
      instructions: cfg.instructions ? cfg.instructions : null,
      tools: enabledTools,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
  }

  private handleBillingUsage(ev: BillingUsageEvent): void {
    const tracker = this.activeTracker;
    if (!tracker) return;
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
          kind: "response",
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
   * Ensures the Pi root conversation exists, lazily migrating any existing legacy
   * `compactions` + `messages` atomically inside `harness.root({ agent, init })`.
   * Idempotent: if the Pi root already exists, `init` does not run.
   */
  async ensureRootMigrated(cfg?: AgentConfig, maxTurns?: number): Promise<{ created: boolean }> {
    await this.ensureStarted();
    const curCfg = cfg ?? this.host.getConfig();
    await this.ensureExtensionsInstalled(curCfg);

    if (this.rootReady) {
      return { created: false };
    }

    const legacyCompRow = this.host.ctx.storage.sql
      .exec<{ id: string; up_to_seq: number; summary: string; created_at: number }>(
        `SELECT id, up_to_seq, summary, created_at FROM compactions ORDER BY up_to_seq DESC, created_at DESC LIMIT 1`,
      )
      .toArray()[0];

    const legacyCompaction: LegacyCompactionRow | null = legacyCompRow
      ? {
          id: legacyCompRow.id,
          upToSeq: legacyCompRow.up_to_seq,
          summary: legacyCompRow.summary,
          createdAt: legacyCompRow.created_at,
        }
      : null;

    const afterSeq = legacyCompaction?.upToSeq ?? 0;
    const legacyMsgRows = this.host.ctx.storage.sql
      .exec<{
        seq: number;
        run_id: string | null;
        role: StoredMessage["role"];
        content_json: string;
        tokens_est: number;
        created_at: number;
      }>(`SELECT * FROM messages WHERE seq > ?1 ORDER BY seq ASC`, afterSeq)
      .toArray();

    const legacyMessages: StoredMessage[] = legacyMsgRows.map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      role: r.role,
      content: JSON.parse(r.content_json) as StoredMessage["content"],
      tokensEst: r.tokens_est,
      createdAt: r.created_at,
    }));

    const modelRef = parsePiModelRef(curCfg.model, this.host.env);
    let migrationResult: {
      importedEntries: number;
      maxLegacySeq: number;
      importedMeta: Array<{ entryId: number; runId: string | null; meta?: Record<string, unknown> }>;
    } = { importedEntries: 0, maxLegacySeq: afterSeq, importedMeta: [] };

    const { created } = await this.harness.root({
      agent: this.buildAgentChange(curCfg, maxTurns),
      init: async (tx, convId) => {
        if (legacyCompaction || legacyMessages.length > 0) {
          migrationResult = await importLegacyTranscriptToPi(
            tx,
            convId,
            legacyCompaction,
            legacyMessages,
            modelRef,
          );
        }
      },
    });

    if (created && (legacyCompaction || legacyMessages.length > 0)) {
      const migratedAt = String(Date.now());
      this.host.ctx.storage.transactionSync(() => {
        for (const item of migrationResult.importedMeta) {
          this.recordEntryMeta(item.entryId, item.runId, item.meta);
        }
        this.host.ctx.storage.sql.exec(
          `INSERT INTO runtime_kv (k, v) VALUES ('pi_migrated_at', ?1)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          migratedAt,
        );
        this.host.ctx.storage.sql.exec(
          `INSERT INTO runtime_kv (k, v) VALUES ('pi_legacy_seq', ?1)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
          String(migrationResult.maxLegacySeq),
        );
      });
    }

    this.rootReady = true;
    return { created };
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
      getOutputSchema: () => this.activeTracker?.outputSchema ?? null,
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

  private async prepareUserInput(
    cfg: AgentConfig,
    prompt: string,
    files: RunFile[],
  ): Promise<{ userInput: UserInput; verifiedFiles: StoredRunFile[] }> {
    if (files.length === 0) {
      return { userInput: prompt, verifiedFiles: [] };
    }
    if (!cfg.lineage) {
      throw new ApiError(400, "invalid_attachments", "Attachments require a configured repository");
    }
    return this.buildUserInputWithFiles(
      cfg,
      prompt,
      files.map((file) => ({ lineage: cfg.lineage!, file })),
    );
  }

  private async startWatchForTracker(tracker: ActiveRunTracker): Promise<void> {
    if (tracker.watchHandle) return;
    const watch = await this.harness.session(ROOT_SESSION).watch();
    tracker.watchHandle = watch;

    // Seed seenEntryIds with all entries that already existed before this run's watch attached
    for (const entry of watch.value.entries) {
      tracker.seenEntryIds.add(Number(entry.id));
    }

    const processView = (view: typeof watch.value) => {
      if (tracker.settled || tracker.pausedForInput || tracker.aborted) return;

      const live = view.docs["pi.live"] as LiveState | undefined;

      // 1. Stream partial assistant text deltas from `pi.live.generation.message`
      if (live?.generation?.message) {
        const attempt = live.generation.attempt;
        const partialMsg = live.generation.message as unknown as AssistantMessage;
        if (attempt !== tracker.emittedGenerationAttempt) {
          tracker.emittedGenerationAttempt = attempt;
          tracker.emittedPartialTextLen = 0;
        }
        const fullText = extractAssistantText(partialMsg);
        if (fullText.length > tracker.emittedPartialTextLen) {
          const delta = fullText.slice(tracker.emittedPartialTextLen);
          tracker.emittedPartialTextLen = fullText.length;
          tracker.accumulatedText += delta;
          this.host.recordAndBroadcastEvent(tracker.runId, "text_delta", { delta });
        }
      }

      // 2. Inspect newly committed entries (handles fast providers like `mock/*` that commit before a partial frame)
      for (const entry of view.entries) {
        const entryNum = Number(entry.id);
        if (tracker.seenEntryIds.has(entryNum)) continue;
        tracker.seenEntryIds.add(entryNum);

        if (UserEntry.is(entry)) {
          const userMeta: Record<string, unknown> = {};
          if (tracker.actor) {
            userMeta.actor = tracker.actor;
            userMeta.requestId = tracker.requestId ?? null;
          }
          if (tracker.verifiedFiles && tracker.verifiedFiles.length > 0) {
            userMeta._files = tracker.verifiedFiles;
          }
          this.recordEntryMeta(
            entryNum,
            tracker.runId,
            Object.keys(userMeta).length > 0 ? userMeta : undefined,
          );
        } else if (AssistantEntry.is(entry)) {
          this.recordEntryMeta(entryNum, tracker.runId);
          const msg = entry.model?.[0];
          if (msg && msg.role === "assistant") {
            const text = extractAssistantText(msg);
            if (text.length > tracker.emittedPartialTextLen) {
              const delta = text.slice(tracker.emittedPartialTextLen);
              tracker.accumulatedText += delta;
              this.host.recordAndBroadcastEvent(tracker.runId, "text_delta", { delta });
            }
            tracker.emittedPartialTextLen = 0;
            tracker.emittedGenerationAttempt = -1;
            tracker.lastEmittedAssistantEntryId = entryNum;

            for (const tc of extractAssistantToolCalls(msg)) {
              if (!tracker.seenToolStarts.has(tc.id)) {
                tracker.seenToolStarts.add(tc.id);
                this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_start", {
                  callId: tc.id,
                  name: tc.name,
                  args: tc.arguments ?? {},
                });
              }
            }
          }
        } else if (ToolResultEntry.is(entry)) {
          this.recordEntryMeta(entryNum, tracker.runId);
          const msg = entry.model?.[0];
          if (msg && msg.role === "toolResult") {
            if (!tracker.seenToolEnds.has(msg.toolCallId)) {
              tracker.seenToolEnds.add(msg.toolCallId);
              const ok = !msg.isError;
              tracker.toolCalls.push({ id: msg.toolCallId, name: msg.toolName, ok });
              this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_end", {
                callId: msg.toolCallId,
                name: msg.toolName,
                ok,
                ...(msg.isError ? { isError: true } : {}),
              });
            }
          }
        }
      }

      // 3. Emit tool_call_start / tool_call_end for live ToolSlots
      for (const slot of live?.tools ?? []) {
        if (!tracker.seenToolStarts.has(slot.callId)) {
          tracker.seenToolStarts.add(slot.callId);
          this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_start", {
            callId: slot.callId,
            name: slot.name,
          });
        }
        if (slot.status === "done" && !tracker.seenToolEnds.has(slot.callId)) {
          const hasErrorDiag = slot.diagnostics?.some((d) => d.severity === "error") ?? false;
          const ok = !hasErrorDiag;
          tracker.seenToolEnds.add(slot.callId);
          tracker.toolCalls.push({ id: slot.callId, name: slot.name, ok });
          this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_end", {
            callId: slot.callId,
            name: slot.name,
            ok,
          });
        }
      }

      // 4. Emit nested codemode tool calls from `pi.live.nestedTools`
      for (const nested of live?.nestedTools ?? []) {
        if (!tracker.seenToolStarts.has(nested.callId)) {
          tracker.seenToolStarts.add(nested.callId);
          this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_start", {
            callId: nested.callId,
            name: nested.name,
            parentCallId: nested.parentCallId,
            args: nested.arguments ?? {},
          });
        }
        if (nested.status === "done" && !tracker.seenToolEnds.has(nested.callId)) {
          const ok = !nested.summary?.isError;
          tracker.seenToolEnds.add(nested.callId);
          tracker.toolCalls.push({ id: nested.callId, name: nested.name, ok });
          this.host.recordAndBroadcastEvent(tracker.runId, "tool_call_end", {
            callId: nested.callId,
            name: nested.name,
            parentCallId: nested.parentCallId,
            ok,
            ...(nested.summary?.error ? { error: nested.summary.error } : {}),
          });
        }
      }

      this.persistTrackerProgress(tracker);
    };

    watch.start(async (call) => {
      if (call.kind === "value") {
        processView(call.value);
      }
    });
  }

  private trackSubmissionSettlement(tracker: ActiveRunTracker): Promise<void> {
    const work = (async () => {
      const cfg = this.host.getConfig();
      const tenantStub = getTenantStub(this.host.env, cfg.tenantId);

      try {
        const result = await this.harness.wait(tracker.runId, { session: ROOT_SESSION });

        // Flush any newly committed entries not yet observed by the async watch (e.g. fast mock turns)
        if (!tracker.aborted) {
          try {
            const finalEntries = await this.harness.session(ROOT_SESSION).messages();
            for (const entry of finalEntries) {
              const entryNum = Number(entry.id);
              if (tracker.seenEntryIds.has(entryNum)) continue;
              tracker.seenEntryIds.add(entryNum);
              if (UserEntry.is(entry)) {
                const userMeta: Record<string, unknown> = {};
                if (tracker.actor) {
                  userMeta.actor = tracker.actor;
                  userMeta.requestId = tracker.requestId ?? null;
                }
                if (tracker.verifiedFiles && tracker.verifiedFiles.length > 0) {
                  userMeta._files = tracker.verifiedFiles;
                }
                this.recordEntryMeta(
                  entryNum,
                  tracker.runId,
                  Object.keys(userMeta).length > 0 ? userMeta : undefined,
                );
              } else if (AssistantEntry.is(entry) || ToolResultEntry.is(entry)) {
                this.recordEntryMeta(entryNum, tracker.runId);
              }
            }
          } catch {
            // Best-effort metadata flush
          }
        }

        // Give any final watch microtask a chance to flush last entry deltas
        if (tracker.watchHandle) {
          await new Promise((r) => setTimeout(r, 0));
          await tracker.watchHandle.stop().catch(() => {});
          tracker.watchHandle = null;
        }

        if (tracker.settled) return;
        tracker.settled = true;

        const now = Date.now();
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
          const finalText = result.text || tracker.accumulatedText;
          if (finalText.length > tracker.accumulatedText.length) {
            const delta = finalText.slice(tracker.accumulatedText.length);
            tracker.accumulatedText = finalText;
            this.host.recordAndBroadcastEvent(tracker.runId, "text_delta", { delta });
          } else {
            tracker.accumulatedText = finalText;
          }
          const parsedOutput = tracker.outputSchema ? tryParseStructuredOutput(finalText) : null;

          this.host.ctx.storage.sql.exec(
            `UPDATE runs
             SET status = 'completed', text = ?1, output_json = ?2, tool_calls_json = ?3,
                 files_changed_json = ?4, usage_json = ?5, error_json = NULL, ended_at = ?6
             WHERE id = ?7`,
            finalText,
            parsedOutput !== null ? JSON.stringify(parsedOutput) : null,
            JSON.stringify(tracker.toolCalls),
            JSON.stringify([...tracker.filesChanged]),
            JSON.stringify(tracker.usage),
            now,
            tracker.runId,
          );
          this.host.recordAndBroadcastEvent(tracker.runId, "run_completed", {
            runId: tracker.runId,
            text: finalText,
            output: parsedOutput,
            usage: tracker.usage,
          });
        } else {
          // Unanswered or post-step spend limit exceeded: spend limit, abort, input expired, or model error
          if (postRunSpendError) {
            const errObj = postRunSpendError;
            const res = this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'failed', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7 AND status NOT IN ('completed', 'failed', 'cancelled')`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            if (res.rowsWritten > 0) {
              this.host.recordAndBroadcastEvent(tracker.runId, "run_failed", {
                runId: tracker.runId,
                error: errObj,
              });
            }
          } else if (tracker.aborted || (result.status !== "done" && result.reason === "aborted")) {
            const errObj = { code: "cancelled", message: "Cancelled via abort" };
            const res = this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'cancelled', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7 AND status NOT IN ('completed', 'failed', 'cancelled')`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            if (res.rowsWritten > 0) {
              this.host.recordAndBroadcastEvent(tracker.runId, "run_cancelled", {
                runId: tracker.runId,
              });
            }
          } else {
            const code = (result.status !== "done" ? result.reason : null) || "run_failed";
            const message = `Run ended unanswered (${code})`;
            const errObj = { code, message };
            const res = this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'failed', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7 AND status NOT IN ('completed', 'failed', 'cancelled')`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            if (res.rowsWritten > 0) {
              this.host.recordAndBroadcastEvent(tracker.runId, "run_failed", {
                runId: tracker.runId,
                error: errObj,
              });
            }
          }
        }

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
        if (!tracker.settled) {
          tracker.settled = true;
          const apiErr = extractApiError(err);
          const code = apiErr?.code ?? "run_failed";
          const message = apiErr?.message ?? (err instanceof Error ? err.message : String(err));
          this.host.ctx.storage.sql.exec(
            `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
            JSON.stringify({ code, message }),
            Date.now(),
            tracker.runId,
          );
          this.host.recordAndBroadcastEvent(tracker.runId, "run_failed", {
            runId: tracker.runId,
            error: { code, message },
          });
        }
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
        this.host.onRunSettled?.(tracker.runId);
        this.host.notifyRunWaiters(tracker.runId);
        if (!this.host.isDestroying()) {
          void this.host.scheduleNextAlarm();
        }
      }
    })();

    tracker.watchPromise = work;
    this.host.ctx.waitUntil(work);
    return work;
  }

  async startRun(body: StartRunInput, hints?: StartRunHints): Promise<RunRecord> {
    if (this.host.isDestroying()) {
      throw new ApiError(409, "agent_deleting", "Agent deletion is in progress");
    }
    const cfg = this.host.getConfig();
    const prompt = String(body.prompt ?? "");
    const whileRunning = body.whileRunning === "steer" ? "steer" : "queue";
    const wait = body.wait !== undefined ? Boolean(body.wait) : true;
    const maxSteps = Math.max(1, Math.min(100, Number(body.maxSteps ?? 25)));
    const spendLimitUsd = body.spendLimitUsd;
    if (spendLimitUsd !== undefined && (!Number.isFinite(spendLimitUsd) || spendLimitUsd < 0)) {
      throw new ApiError(
        400,
        "invalid_spend_limit",
        "spendLimitUsd must be a finite non-negative number",
      );
    }
    if (spendLimitUsd !== undefined && whileRunning === "steer") {
      throw new ApiError(
        400,
        "invalid_spend_limit",
        "A run with a spend limit must use whileRunning: queue",
      );
    }
    const actor = body.actor;
    if (actor !== undefined && (typeof actor !== "string" || !actor.trim() || actor.length > 200)) {
      throw new ApiError(
        400,
        "invalid_actor",
        "actor must be a non-empty string of at most 200 characters",
      );
    }
    const idempotencyKey = body.idempotencyKey?.trim() || null;

    // 1. Idempotency deduplication
    if (idempotencyKey) {
      const existing = this.host.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM runs WHERE idempotency_key = ?1 LIMIT 1`, idempotencyKey)
        .toArray();
      if (existing[0]) {
        this.host.releaseUnusedPreacquiredHint(cfg.tenantId, hints);
        if (wait) return this.host.waitForRunSettlement(existing[0].id);
        return this.host.materializeRunRecord(existing[0].id);
      }
    }

    const files = parseRunFiles(body.files);
    if (files.length > 0 && (whileRunning === "steer" || !cfg.lineage)) {
      throw new ApiError(
        400,
        "invalid_attachments",
        "Attachments require a queued turn and a configured repository",
      );
    }

    await this.ensureStarted();

    // 2. Mid-turn steer when a run is currently executing
    const busy = this.activeTracker && !this.activeTracker.settled && !this.activeTracker.pausedForInput;
    if (whileRunning === "steer" && busy && this.activeTracker && actor === this.activeTracker.actor) {
      this.host.releaseUnusedPreacquiredHint(cfg.tenantId, hints);
      const targetRunId = this.activeTracker.runId;
      const steerRunId = randomId("run", 8);
      const now = Date.now();

      this.host.ctx.storage.sql.exec(
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

      await this.harness.session(ROOT_SESSION).steer(prompt, { operationId: steerRunId });

      if (!wait) {
        return this.host.materializeRunRecord(steerRunId);
      }

      const settledTarget = await this.host.waitForRunSettlement(targetRunId);
      this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = ?1, text = ?2, output_json = ?3, ended_at = ?4 WHERE id = ?5`,
        settledTarget.status,
        settledTarget.text,
        JSON.stringify(settledTarget.output),
        Date.now(),
        steerRunId,
      );
      return this.host.materializeRunRecord(steerRunId);
    }

    // 3. Supersede any parked input_required runs if requested
    if (body.supersedeInputs !== false) {
      await this.supersedePendingInputRuns(actor);
    }

    const runId = hints?.runId ?? randomId("run", 8);
    const now = Date.now();
    const effectiveSpendLimit = spendLimitUsd !== undefined ? spendLimitUsd : null;

    this.host.ctx.storage.transactionSync(() => {
      this.host.ctx.storage.sql.exec(
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
        effectiveSpendLimit,
        actor ?? null,
      );
      if (files.length > 0) {
        this.host.ctx.storage.sql.exec(
          `INSERT INTO run_files (run_id, files_json) VALUES (?1, ?2)`,
          runId,
          JSON.stringify({ lineage: cfg.lineage, files }),
        );
      }
    });

    this.host.recordAndBroadcastEvent(runId, "run_queued", {
      runId,
      queueMode: cfg.queue.mode,
    });

    const tenantStub = getTenantStub(this.host.env, cfg.tenantId);

    // 4. Enforce immediate spend limit = 0 or insufficient credits BEFORE submitting
    const failImmediately = (code: string, message: string): RunRecord => {
      this.host.releaseUnusedPreacquiredHint(cfg.tenantId, hints);
      this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
        JSON.stringify({ code, message }),
        Date.now(),
        runId,
      );
      this.host.recordAndBroadcastEvent(runId, "run_failed", {
        runId,
        error: { code, message },
      });
      this.host.notifyRunWaiters(runId);
      return this.host.materializeRunRecord(runId);
    };

    if (effectiveSpendLimit !== null && effectiveSpendLimit <= 0) {
      return failImmediately(
        "spend_limit_exceeded",
        `Run spend limit exceeded ($0.000000 >= $${effectiveSpendLimit.toFixed(6)})`,
      );
    }

    const effectiveScope =
      hints?.prefetchedProvider?.keyScope !== undefined
        ? (hints.prefetchedProvider.keyScope ?? null)
        : (body.keyScope ?? cfg.keyScope ?? null);
    const { isByok } = await resolveTenantByokProvider(
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

    // 5. Refresh models, ensure lazy migration, sync agent config, and acquire TenantDO slot
    let slotAcquired = false;
    try {
      await this.refreshModels(cfg, { keyScope: body.keyScope, hints });
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
      await this.ensureRootMigrated(cfg, maxSteps);
      await this.ensureMcpExtensionReady(cfg);
      await this.maybeAutoCompact(cfg);
      const { userInput, verifiedFiles } = await this.prepareUserInput(cfg, prompt, files);

      // Sync latest config (model, instructions, enabled tools, maxTurns) onto root conversation
      const pi = await this.harness.pi();
      const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
      if (conv) {
        await conv.configure(this.buildAgentChange(cfg, maxSteps), BG);
      }

      if (hints?.preacquiredSlot) {
        slotAcquired = true;
      } else {
        await tenantStub.acquireSlot(runId, cfg.id);
        slotAcquired = true;
      }

      const tracker: ActiveRunTracker = {
        runId,
        actor,
        verifiedFiles,
        outputSchema: body.outputSchema ?? null,
        spendLimitUsd: effectiveSpendLimit,
        usage: isByok ? { ...emptyUsage(), byok: true } : emptyUsage(),
        filesChanged: new Set(),
        toolCalls: [],
        seenToolStarts: new Set(),
        seenToolEnds: new Set(),
        seenEntryIds: new Set(),
        emittedGenerationAttempt: -1,
        emittedPartialTextLen: 0,
        lastEmittedAssistantEntryId: 0,
        accumulatedText: "",
        slotAcquired,
        settled: false,
        pausedForInput: false,
        spendLimitError: null,
        aborted: false,
        watchHandle: null,
        watchPromise: null,
      };
      this.activeTracker = tracker;
      this.host.setActiveRunId(runId);

      this.host.ctx.storage.sql.exec(`UPDATE runs SET status = 'running' WHERE id = ?1`, runId);
      this.host.recordAndBroadcastEvent(runId, "run_started", {
        runId,
        prompt,
        ...(actor ? { actor } : {}),
      });

      await this.startWatchForTracker(tracker);

      // Submit durably to PiHarness!
      await this.harness.submit(userInput, {
        session: ROOT_SESSION,
        operationId: runId,
        whenBusy: "followUp",
      });

      const settlement = wait ? this.host.waitForRunSettlement(runId) : undefined;
      this.trackSubmissionSettlement(tracker);

      return settlement ? await settlement : this.host.materializeRunRecord(runId);
    } catch (err) {
      if (slotAcquired) {
        await tenantStub.releaseSlot(runId).catch(() => {});
      }
      if (this.activeTracker?.runId === runId) {
        if (this.activeTracker.watchHandle) {
          await this.activeTracker.watchHandle.stop().catch(() => {});
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
    maxSteps: number;
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
      this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'failed', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
        JSON.stringify({ code, message }),
        Date.now(),
        runId,
      );
      this.host.recordAndBroadcastEvent(runId, "run_failed", {
        runId,
        error: { code, message },
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
    const { isByok } = await resolveTenantByokProvider(
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
      await this.refreshModels(cfg, { keyScope: params.keyScope, hints });
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
      await this.ensureRootMigrated(cfg, maxSteps);
      await this.ensureMcpExtensionReady(cfg);
      await this.maybeAutoCompact(cfg);

      const { userInput, verifiedFiles } = await this.buildUserInputWithFiles(
        cfg,
        prompt,
        params.files,
      );

      const pi = await this.harness.pi();
      const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
      if (conv) {
        await conv.configure(this.buildAgentChange(cfg, maxSteps), BG);
      }

      const runRow = this.host.ctx.storage.sql
        .exec<{ idempotency_key: string | null }>(
          `SELECT idempotency_key FROM runs WHERE id = ?1 LIMIT 1`,
          runId,
        )
        .toArray()[0];

      const tracker: ActiveRunTracker = {
        runId,
        actor,
        requestId: runRow?.idempotency_key ?? null,
        verifiedFiles,
        outputSchema,
        spendLimitUsd,
        usage: isByok ? { ...emptyUsage(), byok: true } : emptyUsage(),
        filesChanged: new Set(),
        toolCalls: [],
        seenToolStarts: new Set(),
        seenToolEnds: new Set(),
        seenEntryIds: new Set(),
        emittedGenerationAttempt: -1,
        emittedPartialTextLen: 0,
        lastEmittedAssistantEntryId: 0,
        accumulatedText: "",
        slotAcquired,
        settled: false,
        pausedForInput: false,
        spendLimitError: null,
        aborted: false,
        watchHandle: null,
        watchPromise: null,
      };
      slotAcquired = false; // Ownership transferred to tracker
      this.activeTracker = tracker;
      this.host.setActiveRunId(runId);

      this.host.ctx.storage.sql.exec(`UPDATE runs SET status = 'running' WHERE id = ?1`, runId);
      this.host.recordAndBroadcastEvent(runId, "run_started", {
        runId,
        prompt,
        ...(actor ? { actor } : {}),
      });

      await this.startWatchForTracker(tracker);

      await this.harness.submit(userInput, {
        session: ROOT_SESSION,
        operationId: runId,
        whenBusy: "followUp",
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
    if (inputs.length === 0) return;
    let entries: EntryRecord[] = [];
    try {
      entries = await this.harness.session(ROOT_SESSION).messages();
    } catch {
      entries = [];
    }

    for (const inp of inputs) {
      this.toolResultTextOverrides.set(inp.tool_call_id, reasonText);
      let toolName = "ask_human";
      if (inp.prompt_json) {
        try {
          const parsed = JSON.parse(inp.prompt_json) as { tool?: string };
          if (typeof parsed.tool === "string" && parsed.tool) toolName = parsed.tool;
        } catch {
          // ignore
        }
      }

      // Find the ToolResultEntry written by pi-durable during abort for this callId
      let matchedEntry: EntryRecord | undefined;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (ToolResultEntry.is(entry)) {
          const msg = entry.model?.[0];
          if (msg && msg.role === "toolResult" && msg.toolCallId === inp.tool_call_id) {
            matchedEntry = entry;
            if (msg.toolName) toolName = msg.toolName;
            break;
          }
        }
      }

      if (matchedEntry) {
        this.host.ctx.storage.sql.exec(
          `INSERT INTO pi_entry_meta (entry_id, run_id, meta_json) VALUES (?1, ?2, ?3)
           ON CONFLICT(entry_id) DO UPDATE SET run_id = excluded.run_id, meta_json = excluded.meta_json`,
          Number(matchedEntry.id),
          runId,
          JSON.stringify({ _overrideToolText: reasonText }),
        );
      }

      this.host.recordAndBroadcastEvent(runId, "tool_call_end", {
        callId: inp.tool_call_id,
        name: toolName,
        ok: false,
        error: reasonText,
      });
    }
  }

  async abortExpiredInput(inp: {
    id: string;
    run_id: string;
    tool_call_id: string;
    prompt_json: string | null;
  }): Promise<void> {
    if (this.activeTracker && this.activeTracker.runId === inp.run_id && !this.activeTracker.settled) {
      this.activeTracker.aborted = true;
      if (this.activeTracker.watchHandle) {
        const handle = this.activeTracker.watchHandle;
        this.activeTracker.watchHandle = null;
        await handle.stop().catch(() => {});
      }
    }
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
      if (this.activeTracker && this.activeTracker.runId === paused.id && !this.activeTracker.settled) {
        this.activeTracker.aborted = true;
        if (this.activeTracker.watchHandle) {
          const handle = this.activeTracker.watchHandle;
          this.activeTracker.watchHandle = null;
          await handle.stop().catch(() => {});
        }
      }
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
    await this.ensureRootMigrated(cfg);
    await this.ensureMcpExtensionReady(cfg);
    {
      const pi = await this.harness.pi();
      const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
      if (conv) {
        await conv.configure(this.buildAgentChange(cfg), BG);
      }
    }

    const tenantStub = getTenantStub(this.host.env, cfg.tenantId);

    // Re-attach or resume tracker for this run (handles both in-memory & post-eviction resume!)
    let tracker = this.activeTracker;
    if (!tracker || tracker.runId !== inputRow.run_id || tracker.settled) {
      const existingRec = this.host.materializeRunRecord(inputRow.run_id);
      const runRow = this.host.ctx.storage.sql
        .exec<{ output_schema_json: string | null; spend_limit_usd: number | null; actor: string | null }>(
          `SELECT output_schema_json, spend_limit_usd, actor FROM runs WHERE id = ?1 LIMIT 1`,
          inputRow.run_id,
        )
        .toArray()[0];

      tracker = {
        runId: inputRow.run_id,
        actor: runRow?.actor ?? undefined,
        outputSchema: runRow?.output_schema_json ? JSON.parse(runRow.output_schema_json) : null,
        spendLimitUsd: runRow?.spend_limit_usd ?? null,
        usage: { ...existingRec.usage },
        filesChanged: new Set(existingRec.filesChanged),
        toolCalls: [...existingRec.toolCalls],
        seenToolStarts: new Set(existingRec.toolCalls.map((t) => t.id)),
        seenToolEnds: new Set(existingRec.toolCalls.map((t) => t.id)),
        seenEntryIds: new Set(),
        emittedGenerationAttempt: -1,
        emittedPartialTextLen: 0,
        lastEmittedAssistantEntryId: 0,
        accumulatedText: existingRec.text,
        slotAcquired: false,
        settled: false,
        pausedForInput: false,
        spendLimitError: null,
        aborted: false,
        watchHandle: null,
        watchPromise: null,
      };
      this.activeTracker = tracker;
      await this.startWatchForTracker(tracker);
      this.trackSubmissionSettlement(tracker);
    } else {
      tracker.pausedForInput = false;
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

    if (this.activeTracker && !this.activeTracker.settled) {
      this.activeTracker.aborted = true;
      if (this.activeTracker.watchHandle) {
        const handle = this.activeTracker.watchHandle;
        this.activeTracker.watchHandle = null;
        await handle.stop().catch(() => {});
      }
      cancelledRunIds.push(this.activeTracker.runId);
    }

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

  async compactHistory(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ summary: string; upToSeq: number; compactedCount: number }> {
    const cfg = this.host.getConfig();
    await this.refreshModels(cfg);
    await this.ensureRootMigrated(cfg);

    const pi = await this.harness.pi();
    const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
    if (!conv) {
      return { summary: "", upToSeq: 0, compactedCount: 0 };
    }

    const activeEntries = await this.harness.session(ROOT_SESSION).messages();
    const contentEntries = activeEntries.filter(
      (e) => UserEntry.is(e) || AssistantEntry.is(e) || ToolResultEntry.is(e),
    );
    const keepLast = Math.max(0, Math.trunc(body?.keepLast ?? 0));

    if (body?.summary?.trim()) {
      const summary = body.summary.trim();
      const cutIdx = Math.max(0, contentEntries.length - keepLast);
      // Avoid splitting a tool result from its assistant call
      let safeCutIdx = cutIdx;
      while (safeCutIdx > 0 && ToolResultEntry.is(contentEntries[safeCutIdx])) {
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

    // Run native pi-durable CompactionTask (temporarily setting keepRecentTokens = 0 if keepLast === 0 so manual /compact always summarizes!)
    const prevCompactionSetting = keepLast === 0 ? { enabled: true, keepRecentTokens: 0 } : undefined;
    if (prevCompactionSetting) {
      await conv.configure({ compaction: prevCompactionSetting }, BG);
    }

    try {
      const taskId = await conv.compact(undefined, BG);
      // Drive the compaction task to completion
      const settled = await pi.waitForTask(taskId, BG);
      if (settled.state.status === "terminal" && settled.state.outcome.status === "completed") {
        const result = settled.state.outcome.result as { entryId?: EntryId } | undefined;
        if (result?.entryId !== undefined) {
          const allAfter = await this.listAllEntries();
          const compEntry = allAfter.find((e) => Number(e.id) === Number(result.entryId));
          const msg = compEntry?.model?.[0];
          const rawText =
            msg && msg.role === "user" && typeof msg.content === "string" ? msg.content : "";
          const summary = unwrapCompactionSummary(rawText);
          const upToSeq = Number(compEntry?.head ?? result.entryId);
          this.host.recordAndBroadcastEvent(null, "context_compacted", {
            upToSeq,
            compactedCount: contentEntries.length,
          });
          return { summary, upToSeq, compactedCount: contentEntries.length };
        }
      }
      return { summary: "", upToSeq: 0, compactedCount: 0 };
    } finally {
      if (prevCompactionSetting) {
        await conv.configure({ compaction: null }, BG).catch(() => {});
      }
    }
  }

  async resetContext(body?: {
    summary?: string;
    keepLast?: number;
  }): Promise<{ ok: true; upToSeq: number; summary: string }> {
    const cfg = this.host.getConfig();
    await this.ensureRootMigrated(cfg);

    const summary = body?.summary?.trim() ?? "";
    const beforeEntries = await this.listAllEntries();
    const upToSeq = Number(beforeEntries.at(-1)?.id ?? 0);

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
    const pi = await this.harness.pi();
    const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
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

  private recordEntryMeta(
    entryId: number,
    runId: string | null,
    meta?: Record<string, unknown>,
  ): void {
    try {
      this.host.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO pi_entry_meta (entry_id, run_id, meta_json) VALUES (?1, ?2, ?3)`,
        entryId,
        runId,
        meta ? JSON.stringify(meta) : null,
      );
    } catch {
      // Table may not exist in minimal unit harnesses
    }
  }

  private loadEntryMetaMap(): Map<number, import("./migrate.ts").PiEntryMetadata> {
    const out = new Map<number, import("./migrate.ts").PiEntryMetadata>();
    try {
      const rows = this.host.ctx.storage.sql
        .exec<{ entry_id: number; run_id: string | null; meta_json: string | null }>(
          `SELECT entry_id, run_id, meta_json FROM pi_entry_meta`,
        )
        .toArray();
      for (const r of rows) {
        out.set(Number(r.entry_id), {
          runId: r.run_id,
          ...(r.meta_json ? { meta: JSON.parse(r.meta_json) as Record<string, unknown> } : {}),
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
      // Root not yet migrated — let AgentDO serve legacy SQLite history read-only!
      return null;
    }
    const entries = await this.listAllEntries();
    return mapPiEntriesToHistory(entries, opts, this.loadEntryMetaMap());
  }

  async getMessageCount(): Promise<number | null> {
    if (!this.rootReady && !this.hasPiRootConversation()) {
      return null;
    }
    const entries = await this.listAllEntries();
    return entries.filter(
      (e) => UserEntry.is(e) || AssistantEntry.is(e) || ToolResultEntry.is(e),
    ).length;
  }

  async exportEntriesUpTo(atSeq?: number): Promise<{ entries: EntryRecord[]; targetSeq: number }> {
    await this.ensureRootMigrated();
    const all = await this.listAllEntries();
    const maxSeq = Number(all.at(-1)?.id ?? 0);
    const targetSeq = typeof atSeq === "number" ? atSeq : maxSeq;
    const entries = all.filter((e) => Number(e.id) <= targetSeq);
    return { entries, targetSeq };
  }

  async seedForkEntries(cfg: AgentConfig, entries: EntryRecord[]): Promise<void> {
    await this.ensureStarted();
    await this.refreshModels(cfg);
    await this.ensureExtensionsInstalled(cfg);
    await this.harness.root({
      agent: this.buildAgentChange(cfg),
      init: async (tx, convId) => {
        if (entries.length > 0) {
          await copyPiEntriesToConversation(tx, convId, entries);
        }
      },
    });
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
  }

  async appendPassiveNote(text: string): Promise<boolean> {
    if (!this.rootReady && !this.hasPiRootConversation()) {
      return false;
    }
    await this.ensureStarted();
    const pi = await this.harness.pi();
    const conv = await pi.conversation(1 as import("@earendil-works/pi-durable").ConversationId, BG);
    if (!conv) return false;
    const sub = await conv.submit(
      {
        type: "write",
        entry: {
          kind: UserEntry.kind,
          model: [{ role: "user", content: text, timestamp: Date.now() }],
        },
      },
      BG,
    );
    await sub.wait(BG);
    return true;
  }

  async getLatestMessageMeta(): Promise<{ seq: number; createdAt: number } | null> {
    if (this.rootReady || this.hasPiRootConversation()) {
      const entries = await this.listAllEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (UserEntry.is(e) || AssistantEntry.is(e) || ToolResultEntry.is(e)) {
          const msg = e.model?.[0] as { timestamp?: number } | undefined;
          return { seq: Number(e.id), createdAt: msg?.timestamp || Date.now() };
        }
      }
      return null;
    }
    const row = this.host.ctx.storage.sql
      .exec<{ seq: number; created_at: number }>(
        `SELECT seq, created_at FROM messages ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0];
    return row ? { seq: row.seq, createdAt: row.created_at } : null;
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
      conversationId: 1 as import("@earendil-works/pi-durable").ConversationId,
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

    const history = (await this.getHistory({ limit: 100 })) ?? {
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

    const completion = await completePiModel({
      env: this.host.env,
      tenantId: cfg.tenantId,
      model: cfg.model,
      keyScope: cfg.keyScope ?? null,
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

    void getTenantStub(this.host.env, cfg.tenantId)
      .updateRepoCommit(repoId, writeOut.commit)
      .catch(() => {});

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

  /** Helper so AgentDO can check if a pending `inputs` row belongs to Pi. */
  static isPiInputRow(pendingTurnJson: string | null): boolean {
    if (!pendingTurnJson) return false;
    try {
      return isPiPendingInputMetadata(JSON.parse(pendingTurnJson));
    } catch {
      return false;
    }
  }
}

export type { LifecycleJobContext };
