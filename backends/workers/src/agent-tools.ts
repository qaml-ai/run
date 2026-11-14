import { bashEnabled, bashTool } from "./camelfs/bash.ts";
import { workflowTools } from "./workflow-tools.ts";
import { workflowsEnabled } from "./workflow-routes.ts";
import type { WorkflowEnv } from "./workflow-object.ts";
import { decisionInputs } from "./inbox-decisions.ts";
import { decisionDetail, argumentsHash } from "./decision-inputs.ts";
import { builtinDefinitions as inboxBuiltinDefinitions } from "./inbox-definitions.ts";
import { retriesModelError } from "./model-errors.ts";
import { modelCompactionSettings } from "./model-context.ts";
import { withCompactionPrompt } from "./model-compaction.ts";
import { takesFiles } from './tool-file-schema.ts';
import { toolOutputExtension } from "./tool-output.ts";
import { agentUpdatesExtension } from "./agent-updates.ts";
import { assertContextRange, contextRangeExtension, contextRangeLimit } from "./context-range.ts";
import { toolCallSite } from "./tool-call-context.ts";
import { Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { SessionCodemodeSandbox } from "../codemode/sandbox.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { PiHarness } from "agents/harness/pi";
import { startStuck } from "./agent-lifecycle.ts";
import { computerOwner, computerDisabled, hasComputer } from "../../../src/core/computer-share.ts";
import { withSql as shareSql } from "./postgres.ts";
import { computerTool } from "./computers/tool.ts";
import { computerSetup } from "./computers/agent-setup.ts";
import { askHuman, makeAskUser, humanInputExtension } from "./human.ts";
import { repoTools } from "./repos/tools.ts";
import type { Mount } from "./repos/mounts.ts";
import { attachedComputerTools } from "./computers/agent-tools.ts";
import { ComputerService } from "./computers/service.ts";
import { modelRuntime } from "./model.ts";
import { meterProvider, applyModelReceipt } from "./model-metering.ts";
import { keyServices } from "./security-services.ts";
import { runtimePromptSections } from "./prompt-sections.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { prioritizedTools } from "./tool-priority.ts";
import { compatibleFileTools } from "./fs-tools.ts";
import { sourceTools } from "./tool-sources.ts";
import { resolveCustomProviders } from "./model-credentials.ts";
import { resolveModelCredentials } from "./model-endpoints.ts";
import { decisionService, recordDecision } from "./decision-service.ts";
import { offersDecisions } from "./decision-runtime.ts";
import { hostExecutionTool } from "./host-execution.ts";
import { schemaAccepts } from "./output-validation.ts";
import { senderExtension } from "./sender-extension.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { agentBuiltins } from "./agent-builtins.ts";
import { writtenFile, presentedFile } from "./file-output.ts";
import { selectAgentTools, wordedFileTools } from "./file-tool-selection.ts";
import { Env } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export function createDecisions(this: AgentRuntime): ReturnType<typeof decisionService> {
  return decisionService(
    this.env,
    async (api) => {
      const conf = await this.config();
      const run = await this.currentRun(api);
      const params = "params" in run ? run.params : undefined;
      return {
        tenant: conf.tenantId,
        agent: conf.id,
        requestId: run.id === "background" ? undefined : run.id,
        bucket: (params?.bucket as string | undefined) ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
        spendLimit: (params?.spendLimit as { usd?: number } | undefined)?.usd,
        actor: params?.actor as string | undefined,
        identity: {
          subject: (params?.endUser as string | undefined) ?? conf.config.subject,
          context: conf.config.context,
        },
        keyScope: conf.config.keyScope,
        dataCollection: conf.config.dataCollection,
      };
    },
    async (context, usage) => {
      const conf = await this.config();
      await recordDecision(
        this.env,
        context,
        usage,
        conf.id,
        context.requestId,
      );
    },
  );
}

export function createModels(this: AgentRuntime): ReturnType<typeof modelRuntime> {
  return modelRuntime(
    this.env,
    async () => (await this.config()).tenantId,
    {
      agentId: async () => (await this.config()).id,
      authorizeRepoFile: async file=>{
        const conf=await this.config();
        return (await import('./repos/attachments.ts')).authorizedAttachment(this.env,conf.tenantId,(conf.config.mounts??[]) as import('./files.ts').Mount[],file);
      },
      onRetryEvent: async (event) => {
        await this.emit({ type: "event", requestId: (await this.currentRun()).id, event });
      },
      // Pi batches its live document. Project the provider's individual deltas
      // through the same projection so short chunks remain observable.
      onStreamEvent: async (event) => {
        if (event.type === "error") {
          const conf = await this.config();
          const endpoints = (await keyServices(this.env)).tenants.modelEndpoints(conf.tenantId);
          const provider = (conf.config.model ?? this.env.MODEL).split("/")[0];
          this.retryModelFailure = retriesModelError(event.error, { ownEndpoint: !!endpoints?.[provider] });
        } else if (event.type === "done") this.retryModelFailure = true;
        if (!("partial" in event)) return;
        await this.eventsProcessed;
        const run = await this.currentRun();
        await this.markBegan(run.id);
        this.partial = event.partial;
        await this.projectMessage(run.id, event.partial, false);
        if (event.type === "toolcall_delta")
          await this.emit({ type: "event", requestId: run.id, event: {
            type: "message_update", assistantMessageEvent: {
              type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta,
            },
          } });
      },
      onDiscardedOutput: async (message) => {
        const run = await this.currentRun();
        await this.ctx.storage.put({ [`discarded-output:${run.id}`]: message, [`output-reminded:${run.id}`]: true });
        await this.projectMessage(run.id, message, true);
        this.nextMessage--;
        this.partial = null;
        await this.emit({ type: "event", requestId: run.id, event: { type: "message_retracted", index: this.nextMessage } });
      },
      onStall: async (stall) => {
        const run = await this.currentRun();
        await this.emit({ type: "event", requestId: run.id, event: { type: "model_stream_stalled", ...stall } });
      },
      beforeRequest: async () => {
        const stopped = await this.limits.check();
        if (stopped) throw new Error(stopped.error);
        await assertContextRange(
          contextRangeLimit((this.env as Env & { AGENT_CONTEXT_RANGE_MAX_BYTES?: string }).AGENT_CONTEXT_RANGE_MAX_BYTES),
          await (await this.harness.pi()).root(BACKGROUND_CONTEXT),
          async failure => { await this.ctx.storage.put(`run-limit:${(await this.currentRun()).id}`, failure); },
        );
      },
      wrapProvider: (provider) =>
        meterProvider(
          provider,
          this.env,
          async () => {
            const conf = await this.config(),
              run = await this.currentRun();
            const params = "params" in run ? run.params : undefined;
            return {
              tenant: conf.tenantId,
              agent: conf.id,
              requestId: run.id === "background" ? undefined : run.id,
              subject: (params?.endUser as string | undefined) ?? conf.config.subject,
              context: conf.config.context,
              bucket:
                (params?.bucket as string | undefined) ?? conf.config.bucket,
              actor: params?.actor as string | undefined,
              keyScope: conf.config.keyScope,
              spendLimit: (params?.spendLimit as { usd?: number } | undefined)
                ?.usd,
              platform: this.env.TEST_MODEL !== "1",
            };
          },
          async (receipt) => {
            const key = `model-billing:${receipt.event.id}`;
            await this.ctx.storage.put(key, receipt);
            await this.dbProfile.run("settle", () => applyModelReceipt(this.env, receipt));
            await this.ctx.storage.delete(key);
          },
          async (context, stop) => {
            if (context.requestId) {
              await this.ctx.storage.put(`run-limit:${context.requestId}`, stop);
              await this.emit({ type: "event", requestId: context.requestId, event: { type: "spend_limit_reached", message: stop.error } });
            }
          },
          action => this.dbProfile.run("admission", action),
        ),
      settings: async () => {
        const conf = await this.config();
        const run = await this.currentRun();
        const params = "params" in run ? run.params : undefined;
        return {
          ...conf.config,
          ...params,
          requestId: run.id,
          outputReminded: !!(await this.ctx.storage.get(`output-reminded:${run.id}`)),
          runLimits: {
            ...conf.config.runLimits,
            ...(params?.runLimits as object),
          },
        };
      },
      invocation: () => this.invocation(),
      credentials: async (provider, invocation = this.invocation()) => {
        const conf = await this.config();
        return resolveModelCredentials(
          this.env,
          conf.tenantId,
          provider,
          await this.sourceIdentity(),
          conf.config.keyScope,
          invocation,
        );
      },
    },
  );
}

export async function computerNamesImpl(this: AgentRuntime) {
    if (!this.env.HYPERDRIVE) return new Set<string>();
    const conf = await this.config();
    return new Set(
      (await new ComputerService(this.env, conf.tenantId).tools(conf.id)).map(
        (tool) => tool.name,
      ),
    );
  }

export async function refreshComputerToolsImpl(this: AgentRuntime) {
    const conf = await this.config();
    const pi = await this.harness.pi(),
      root = await pi.root(BACKGROUND_CONTEXT);
    const enabled = await this.enabledTools(conf.config);
    await root.configure(enabled, BACKGROUND_CONTEXT);
  }

export async function enabledToolsImpl(this: AgentRuntime,
  config: AgentConfiguration) {
    return selectAgentTools(
      this.availableTools,
      new Set(this.workspaceToolNames),
      config,
      await this.computerNames(),
      await this.hasNativeComputer(config),
    );
  }

/**
 * This agent has a native computer: the deployment binds them, and the agent shares its parent's or its configuration
 * declares `computer`. Read each turn (a share is recorded after the child is made); without one the `computer` tool is
 * neither offered nor listed, and nothing starts a container for it.
 */
export async function hasNativeComputerImpl(this: AgentRuntime, config?: AgentConfiguration) {
  if (!this.env.COMPUTER_CONTAINERS) return false;
  const conf = await this.config();
  return shareSql(this.env, sql => hasComputer(sql, conf.tenantId, conf.id, (config ?? conf.config).computer !== undefined));
}

export function createHarness(this: AgentRuntime): PiHarness {
  return new PiHarness({
    defaults: { model: this.models.model },
    harness: async ({ storage, context, onWake }) => {
      // Pi's open runs inside the SDK's startup (blockConcurrencyWhile, reset after 30 s): its slow parts are logged
      // (agent_start_slow), as restorePending's are; on the pilot, resets came before onStart ran.
      let lapAt = Date.now(), stuck = startStuck(this, "harness model (config, custom providers, key services)");
      // A step that throws clears its timer too, or the step would be logged stuck (agent_start_stuck) after it failed.
      try {
        const lap = (step: string, next?: string) => {
          const now = Date.now(); clearTimeout(stuck);
          if (now - lapAt > 2_000) console.warn(JSON.stringify({ type: "agent_start_slow", step, ms: now - lapAt, sinceConstructedMs: now - this.constructedAt }));
          lapAt = now; if (next) stuck = startStuck(this, next);
        };
        const registry = this.registry;
        const conf = await this.config();
        // A recreated object must register the stored custom model before Pi resumes tasks.
        const model = this.models.resolve(
          conf.config.model,
          conf.config.runLimits?.contextTokens,
          await resolveCustomProviders(
            this.env,
            conf.tenantId,
            conf.config.keyScope,
          ),
          (await keyServices(this.env)).tenants.modelEndpoints(conf.tenantId),
          conf.resolvedModel,
        );
        lap("harness model (config, custom providers, key services)", "harness tools");
        this.modelCompaction = fixed => modelCompactionSettings(model, conf.config.maxOutputTokens, fixed);
        registry.install(
          runtimePromptSections(
            async () => {
              const current = await this.config();
              const config = current.config;
              const run = await this.currentRun();
              return { ...config, sharedAgent: "sharedAgent" in run ? run.sharedAgent : undefined, output: "params" in run ? run.params?.output : undefined } as never;
            },
          ),
        );
        registry.install(senderExtension());
        registry.install(humanInputExtension());
        registry.install(toolOutputExtension(this.env, async (api, callId) => {
          const conf = await this.config(), pi = await this.harness.pi();
          const site = await toolCallSite({ taskId: api.taskId, callId, getTask: pi.getTask.bind(pi) } as ToolExecutionApi);
          if (site.assistant !== undefined) {
            await this.historyIndex.sync(await pi.root(BACKGROUND_CONTEXT));
            site.messageIndex = this.historyIndex.messageIndex(site.assistant);
          }
          return { tenant: conf.tenantId, agent: conf.id, requestId:await this.fileRequestId(), mounts: (conf.config.mounts ?? []) as Mount[], fileTools: conf.config.fileTools, codeMode: conf.config.codeMode, fileArguments: Object.fromEntries([...(conf.config.mcpServers ?? []), ...(conf.config.openApi ?? [])].map(source => [source.name, takesFiles(source)])), call: site };
        }));
        // After the result is capped (tool-output.ts keeps the <agent_updates> part whole): children's progress rides on it.
        registry.install(agentUpdatesExtension(() => this.delegation, async (api, callId) => {
          const pi = await this.harness.pi();
          const site = await toolCallSite({ taskId: api.taskId, callId, getTask: pi.getTask.bind(pi) } as ToolExecutionApi);
          return site.assistant === undefined ? [] : (await api.entry(site.assistant as never, BACKGROUND_CONTEXT))?.model ?? [];
        }));
        registry.install(this.limits.extension());
        registry.install(contextRangeExtension(
          contextRangeLimit((this.env as Env & { AGENT_CONTEXT_RANGE_MAX_BYTES?: string }).AGENT_CONTEXT_RANGE_MAX_BYTES),
          async () => (await this.harness.pi()).root(BACKGROUND_CONTEXT),
          async failure => { await this.ctx.storage.put(`run-limit:${(await this.currentRun()).id}`, failure); },
        ));
        // User files live in repos; code runs in the separate sandbox.
        const templates = repoTools(
          this.env,
          "_uninitialized",
          "_uninitialized",
        );
        const tools: ToolRegistration[] = compatibleFileTools(
          templates.map((tool, index) => ({
            ...tool,
            execute: async (args, api, context) => {
              const config = await this.config();
              const scope = this.repoTrees.scope();
              try {
                const impl = repoTools(
                  this.env,
                  config.tenantId,
                  config.id,
                  async () => (config.config.mounts as never) ?? [],
                  async (file, resolvedPath) => {
                    await presentedFile(
                      this.ctx.storage,
                      this.env,
                      {
                        requestId: await this.fileRequestId(api.conversationId),
                        callId: api.callId,
                        tenant: config.tenantId,
                        origin: await this.ctx.storage.get<string>("file-origin"),
                      },
                      file,
                      resolvedPath,
                      (event) => this.emit(event),
                    );
                  },
                  async (file) =>
                    writtenFile(
                      this.ctx.storage,
                      await this.fileRequestId(api.conversationId),
                      file,
                    ),
                  this.fileVersions,
                  { "Camel-Run": await this.fileRequestId(api.conversationId), "Camel-Call": api.callId },
                  scope,
                  this.invocation(),
                )[index];
                return await impl.execute(args as never, api, context);
              } finally {
                scope.close();
              }
            },
          })),
        );
        this.workspaceToolNames = tools.map((tool) => tool.name);
        this.workspaceFileTools = tools;
        registry.install({
          name: "camel.files",
          tools: wordedFileTools(tools, conf.config),
          sections: [],
        });
        const attachments = async (items: any[]) => {
          const conf = await this.config();
          const found: any[] = [];
          const present = repoTools(this.env, conf.tenantId, conf.id, async () => conf.config.mounts as Mount[] ?? [], async file => { found.push({ path: file.path, version: file.version, contentType: file.contentType, ...(file.caption ? { caption: file.caption } : {}) }); }).find(tool => tool.name === "present_file")!;
          for (const item of items) await present.execute(item, {} as never, BACKGROUND_CONTEXT);
          return found;
        };
        const decisionDefinition = inboxBuiltinDefinitions(["request_decision"])[0];
        const requestDecision: ToolRegistration = { ...decisionDefinition, replay: "safe", structuredOutputSchema: {}, callers: ["model", "tools"], async execute(args, api) {
          const detail = decisionDetail(args as Record<string, any>);
          if (detail.attachments?.length) detail.attachments = await attachments(detail.attachments);
          const conf = await runtime.config(), run = await runtime.currentRun(api);
          const position = await runtime.delegation.lineage(conf.id, run);
          const lineage = [...position?.chain ?? [], conf.id];
          const rows = await decisionInputs(runtime).create({ agent: conf.id, tenant: conf.tenantId, requestId: run.id, toolCallId: api.callId,
            tool: "request_decision", argumentsHash: argumentsHash("request_decision", args), responders: "actor" in run && run.actor ? { audience: [run.actor] } : {},
            approvers: conf.config.humanInput?.approvers as string[] | undefined, subject: conf.config.subject, rootAgent: lineage[0], lineage, blocking: false, itemKey: (args as any).key,
            expiresAt: Math.min(Date.now() + 7 * 86400000, conf.expiresAt ?? Infinity),
          }, [{ kind: "decision", message: detail.title, detail }]);
          await runtime.ctx.storage.put("decision-input-deadline", Math.min(await runtime.ctx.storage.get<number>("decision-input-deadline") ?? Infinity, rows[0].expiresAt));
          await runtime.arm();
          const value = { inputId: rows[0].id };
          return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
        } };
        const runtime = this;
        registry.install({ name: "camel.human", tools: [askHuman, makeAskUser(attachments, conf.config.builtins ?? []), ...((conf.config.builtins ?? []).includes("request_decision") ? [requestDecision] : [])] });
        // A channel's agents send updates and files to their conversation before the final reply. One that also messages
        // agents (its sub-agents) gets one send_message for both, dispatched on `to` (installed with camel.delegation).
        const messaging = this.channels.messaging(async () => this.config(), async api => { const run = await this.currentRun(api as never); return run.id === "background" ? undefined : run.id; },
          conf.config.type === "channel", await this.delegation.toolsFor(conf.config.delegate ?? {}, conf.config.builtins ?? [], conf.config.type === "subagent"));
        registry.install({ name: "camel.channels", tools: messaging.channels });
        registry.install({
          name: "camel.images",
          tools: await this.imageTools(),
        });
        registry.install({
          name: "camel.computers",
          tools: conf.config.networking?.type === "limited" ? [] : attachedComputerTools(
            this.env,
            () => this.config(),
            (run) =>
              this.serializeComputer(async () => {
                try {
                  return await run();
                } finally {
                  await this.arm();
                }
              }),
          ),
        });
        registry.install({
          name: "camel.application",
          tools: this.attached.tools(conf.config.mcp?.tools ?? [], (api) =>
            this.sourceIdentity(api),
          ),
        });
        registry.install({
          name: "camel.sources",
          tools: await sourceTools(
            this.env,
            conf.tenantId,
            conf.config.definition,
            conf.config as never,
            undefined,
            (api) => this.sourceIdentity(api),
            (failures) => { this.sourceFailures = failures; },
            (input, api, context) => this.decisions.judge(input, context.abortSignal ?? new AbortController().signal, api),
          ),
        });
        registry.install({
          // A sub-agent has no schedules (createScheduleImpl refuses them): it is offered no schedule tools.
          name: "camel.web",
          tools: await agentBuiltins(this.env, async (api) => {
            const conf = await this.config();
            const run = await this.currentRun(api);
            const params = "params" in run ? run.params : undefined;
            return {
              tenant: conf.tenantId,
              agent: conf.id,
              requestId: run.id === "background" ? undefined : run.id,
              spendLimit: (params?.spendLimit as { usd?: number } | undefined)
                ?.usd,
              networking: conf.config.networking,
              builtins: conf.config.builtins,
              webSearch: conf.config.webSearch,
              keyScope: conf.config.keyScope,
              identity: { subject: (params?.endUser as string | undefined) ?? conf.config.subject, context: conf.config.context },
              actor: ("actor" in run ? run.actor : undefined) ?? params?.actor as string | undefined,
              bucket: (params?.bucket as string | undefined) ?? conf.config.bucket ?? await this.ctx.storage.get<string>("run-bucket") ?? "default",
              files: (await this.sourceIdentity(api)).toolFiles('web_fetch'),
            };
          }, { schedules: conf.config.type === "subagent" ? undefined : this.scheduleTools() }),
        });
        registry.install({
          name: "camel.decisions",
          tools:
            offersDecisions(conf.config) && (await this.decisions.available())
              ? [this.decisions.tool()]
              : [],
        });
        registry.install({
          name: "camel.output",
          tools: [
            {
              name: "final_output",
              description: "End the run with the requested structured output.",
              parameters: { type: "object", additionalProperties: true },
              callers: ["model"],
              replay: "safe",
              execute: async (args, api) => {
                const run = await this.currentRun(api);
                const schema = (
                  "params" in run ? run.params?.output : undefined
                ) as { schema?: object } | undefined;
                if (!schema?.schema)
                  throw new Error("This run has no output schema");
                if (!schemaAccepts(schema.schema, args)) {
                  throw new Error('Validation failed for tool "final_output": arguments do not match the requested schema');
                }
                await this.ctx.storage.put(`output:${run.id}`, args);
                return {
                  output: [{ type: "text", text: "Accepted." }],
                  details: { output: args as JsonValue },
                  control: { terminate: true },
                };
              },
            },
          ],
        });
        registry.install({
          name: "camel.delegation",
          tools: messaging.delegation,
        });
        // The workflows builtin: for an agent that may delegate (not a sub-agent), unless its configuration says
        // workflows: false, on a tenant that has workflows.
        const workflowSettings = conf.config.workflows;
        if (conf.config.delegate && workflowSettings !== false && conf.config.type !== "subagent" && workflowsEnabled(this.env as never, conf.tenantId)) {
          registry.install({ name: "camel.workflows", tools: workflowTools({
            env: this.env as unknown as WorkflowEnv, tenant: conf.tenantId, agentId: conf.id,
            ...(conf.runtimeOrigin ? { runtimeOrigin: conf.runtimeOrigin } : {}),
            ...(conf.config.bucket ? { bucket: conf.config.bucket as string } : {}),
            ...(typeof workflowSettings === "object" && workflowSettings?.maxBudgetUsd !== undefined ? { maxBudgetUsd: workflowSettings.maxBudgetUsd } : {}),
            remaining: async () => { const spend = await this.agentSpend(await this.config()); return spend ? Math.max(0, spend.usd - spend.spent) : Infinity; },
            // Its workflows are background children of its (workflow-endings.ts): their endings come as a child's.
            children: {
              register: (workflow, api) => this.delegation.registerWorkflow(workflow, api as never),
              reopen: id => this.delegation.reopenWorkflow(id),
              forget: id => this.delegation.forgetWorkflow(id),
            },
          }) });
        }
        const noComputer = await shareSql(this.env, sql => computerDisabled(sql, conf.tenantId, conf.id));
        registry.install({
          name: "camel.linux",
          tools: noComputer ? [] : bashEnabled(this.env) ? [bashTool(this)] : [computerTool(this.env, this.ctx.id.toString(), async () => computerSetup(this.env, await this.config()), { ...conf.config.computer, networking: conf.config.networking }, async () => { const owner = await shareSql(this.env, sql => computerOwner(sql, conf.tenantId, conf.id)); return { id: this.env.AGENTS.idFromName(owner).toString(), shared: owner !== conf.id }; })],
        });
        const sandbox = new SessionCodemodeSandbox({ remote: this.sandboxRemote });
        registry.install({
          name: "camel.host-execute",
          tools: [hostExecutionTool(sandbox)],
        });
        this.codeExtension = createCodemodeExtension({
          sandbox,
          // Keep provider calls outside the script's capability set.
          models: false,
        });
        registry.install(this.codeExtension);
        this.availableTools = prioritizedTools(registry.snapshot().tools());
        lap("harness tools", "Harness.open");
        const opened = await Harness.open(
          storage,
          {
            models: this.models.models,
            registry: withCompactionPrompt(registry, fixed => this.modelCompaction?.(fixed)),
            onWake,
            settings: () => ({
              afterFailedRun: "withdraw",
              // An agent whose queue batches takes every steer waiting at a tool round's end, not one per round, and
              // starts its next run with every follow-up waiting (batch-queue.ts keeps only joinable ones there).
              steeringMode: this.batching ? "all" : "one-at-a-time",
              followUpMode: this.batching ? "all" : "one-at-a-time",
              compaction: this.modelCompaction?.(0),
              retry: { enabled: this.retryModelFailure, maxRetries: 2, baseDelayMs: 500 },
            }),
          },
          context,
        );
        lap("Harness.open");
        return opened;
      } finally { clearTimeout(stuck); }
    },
  });
}
