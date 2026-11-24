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
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { openPiSessionStore, PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import type { DurableObject } from "cloudflare:workers";
import { CamelFsClient } from "../camelfs.ts";
import { randomId } from "../crypto.ts";
import { consumeInfraCredit } from "../ops-metadata.ts";
import { getModelContextWindow, resolveTenantByokProvider } from "../providers.ts";
import { verifyRunFiles } from "../run-files.ts";
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
  createProviderRequestExtension,
  parsePiModelRef,
} from "./models.ts";
import { parseRunFiles } from "../run-files.ts";

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
}

interface ActiveRunTracker {
  runId: string;
  actor?: string;
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
  spendLimitError: { code: "run_spend_limit_exceeded"; message: string } | null;
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

            const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
            return {
              output: [{ type: "text", text }],
              structuredOutput: JSON.parse(JSON.stringify(result ?? null)),
            };
          },
        }) as unknown as ToolRegistration,
      );
    }

    return defineExtension({
      name: "camelrun-custom-and-web",
      tools,
    });
  }

  private async ensureExtensionsInstalled(cfg: AgentConfig): Promise<void> {
    const snap = this.registry.snapshot();

    if (!snap.extension("camelrun-provider-request")) {
      this.registry.install(
        createProviderRequestExtension({
          getOutputSchema: () => this.activeTracker?.outputSchema ?? null,
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
                code: "run_spend_limit_exceeded",
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
        }),
      );
    }

    const customFp = JSON.stringify(cfg.tools ?? []);
    if (customFp !== this.installedCustomFingerprint || !snap.extension("camelrun-custom-and-web")) {
      this.registry.install(this.buildCustomAndWebExtension(cfg));
      this.installedCustomFingerprint = customFp;
    }

    if (!snap.extension("camelrun-mcp")) {
      this.registry.install(defineExtension({ name: "camelrun-mcp", tools: [] }));
    }
  }

  /**
   * Discover & install remote MCP tools lazily ONLY when starting or resuming a run.
   * Never perform remote MCP HTTP calls during `PUT /v2/agents`, `scheduleNextAlarm`,
   * `syncModelChange`, or `GET /history` — callers like `camel-bots` often upsert the
   * agent before activating its ID in their tool-server ACL.
   */
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
    const billedStepUsd = tracker.usage.byok ? 0 : ev.costUsd;
    tracker.usage.costUsd = Number((tracker.usage.costUsd + billedStepUsd).toFixed(8));

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
    let migrationResult = { importedEntries: 0, maxLegacySeq: afterSeq };

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

  private async prepareUserInput(
    cfg: AgentConfig,
    prompt: string,
    files: RunFile[],
  ): Promise<UserInput> {
    if (files.length === 0) {
      return prompt;
    }
    if (!cfg.lineage) {
      throw new ApiError(400, "invalid_attachments", "Attachments require a configured repository");
    }
    const cfs = new CamelFsClient(this.host.env, cfg.tenantId);
    const verified = await verifyRunFiles(
      cfs,
      files.map((file) => ({ lineage: cfg.lineage!, file })),
      { env: this.host.env, tenantId: cfg.tenantId },
    );

    const blocks: (TextContent | ImageContent)[] = [];
    const lines = [
      prompt,
      ...verified.map(
        (f) =>
          `Workspace attachment ${JSON.stringify(f.path)} at commit ${f.commit} (${f.contentType}, ${f.size} bytes).`,
      ),
    ].filter(Boolean);
    blocks.push({ type: "text", text: lines.join("\n") });
    return blocks;
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
      if (tracker.settled) return;

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

        if (AssistantEntry.is(entry)) {
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

        // Give any final watch microtask a chance to flush last entry deltas
        if (tracker.watchHandle) {
          await new Promise((r) => setTimeout(r, 0));
          await tracker.watchHandle.stop().catch(() => {});
          tracker.watchHandle = null;
        }

        if (tracker.settled) return;
        tracker.settled = true;

        const now = Date.now();
        if (result.status === "done") {
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
          // Unanswered: spend limit, abort, input expired, or model error
          if (tracker.spendLimitError) {
            const errObj = tracker.spendLimitError;
            this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'failed', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            this.host.recordAndBroadcastEvent(tracker.runId, "run_failed", {
              runId: tracker.runId,
              error: errObj,
            });
          } else if (tracker.aborted || result.reason === "aborted") {
            const errObj = { code: "cancelled", message: "Cancelled via abort" };
            this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'cancelled', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7 AND status != 'cancelled'`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            this.host.recordAndBroadcastEvent(tracker.runId, "run_cancelled", {
              runId: tracker.runId,
            });
          } else {
            const code = result.reason || "run_failed";
            const message = `Run ended unanswered (${code})`;
            const errObj = { code, message };
            this.host.ctx.storage.sql.exec(
              `UPDATE runs
               SET status = 'failed', text = ?1, tool_calls_json = ?2, files_changed_json = ?3,
                   usage_json = ?4, error_json = ?5, ended_at = ?6
               WHERE id = ?7`,
              tracker.accumulatedText,
              JSON.stringify(tracker.toolCalls),
              JSON.stringify([...tracker.filesChanged]),
              JSON.stringify(tracker.usage),
              JSON.stringify(errObj),
              now,
              tracker.runId,
            );
            this.host.recordAndBroadcastEvent(tracker.runId, "run_failed", {
              runId: tracker.runId,
              error: errObj,
            });
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
        "run_spend_limit_exceeded",
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
      await this.ensureMcpExtensionReady(cfg);
      await this.ensureRootMigrated(cfg, maxSteps);
      const userInput = await this.prepareUserInput(cfg, prompt, files);

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

  private async supersedePendingInputRuns(actor?: string): Promise<void> {
    const pausedRuns = this.host.ctx.storage.sql
      .exec<{ id: string; actor: string | null }>(
        `SELECT id, actor FROM runs WHERE status = 'input_required' AND batched_into IS NULL ORDER BY started_at ASC`,
      )
      .toArray();
    const matching = pausedRuns.filter((r) => !actor || !r.actor || r.actor === actor);
    if (matching.length === 0) return;

    await this.harness.abort({ session: ROOT_SESSION }).catch(() => {});
    const now = Date.now();
    for (const paused of matching) {
      const pendingInputs = this.host.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM inputs WHERE run_id = ?1 AND status = 'pending'`, paused.id)
        .toArray();
      this.host.ctx.storage.sql.exec(
        `UPDATE inputs SET status = 'superseded' WHERE run_id = ?1 AND status = 'pending'`,
        paused.id,
      );
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
      this.host.recordAndBroadcastEvent(paused.id, "run_cancelled", {
        runId: paused.id,
        code: "superseded",
      });
      this.host.notifyRunWaiters(paused.id);
    }
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
    await this.ensureMcpExtensionReady(cfg);
    await this.ensureRootMigrated(cfg);

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

    if (this.activeTracker && !this.activeTracker.settled) {
      this.activeTracker.aborted = true;
      cancelledRunIds.push(this.activeTracker.runId);
    }

    await this.ensureStarted();
    if (body?.keepQueued && this.activeTracker) {
      await this.harness.abort({ session: ROOT_SESSION, operationId: this.activeTracker.runId }).catch(() => {});
    } else {
      await this.harness.abort({ session: ROOT_SESSION }).catch(() => {});
    }

    const now = Date.now();
    const inputStatus = body?.supersedeInputs ? "superseded" : "cancelled";
    const errorObj = body?.supersedeInputs
      ? { code: "superseded", message: "Superseded by a new message" }
      : { code: "cancelled", message: "Cancelled via abort" };

    const activeOrPaused = this.host.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM runs WHERE status IN ('running', 'input_required')`,
      )
      .toArray();
    for (const row of activeOrPaused) {
      if (!cancelledRunIds.includes(row.id)) cancelledRunIds.push(row.id);
      this.host.ctx.storage.sql.exec(
        `UPDATE inputs SET status = ?1 WHERE run_id = ?2 AND status = 'pending'`,
        inputStatus,
        row.id,
      );
      this.host.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'cancelled', error_json = ?1, ended_at = ?2 WHERE id = ?3`,
        JSON.stringify(errorObj),
        now,
        row.id,
      );
      this.host.recordAndBroadcastEvent(row.id, "run_cancelled", { runId: row.id });
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
    return mapPiEntriesToHistory(entries, opts);
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
