import { ToolFiles } from './tool-files.ts';
import { TOOL_FILE_LIMITS } from '../../../src/limits.ts';
import { toolCallSite } from "./tool-call-context.ts";
import { type LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Mount } from "./files.ts";
import { PromptAttachments } from "./prompt-attachments.ts";
import { hostExecutionRequest } from "./host-execution.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { runSpend } from "./agent-spend.ts";
import { withSql } from "./postgres.ts";
import { writtenFile } from "./file-output.ts";
import { agentMediaTools } from "./agent-media.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function imageToolsImpl(this: AgentRuntime) {
    return agentMediaTools(
      this.env,
      async (api) => {
        const conf = await this.config(),
          run = await this.currentRun(api);
        const params = "params" in run ? run.params : undefined;
        const spendLimit = (params?.spendLimit as { usd?: number } | undefined)
          ?.usd;
        const spend = await this.agentSpend(conf);
        let budget = spend ? Math.max(0, spend.usd - spend.spent) : Infinity;
        if (spendLimit !== undefined) {
          const used = await withSql(this.env, (sql) =>
            runSpend(sql, conf.tenantId, conf.id, run.id),
          );
          budget = Math.min(
            budget,
            Math.max(
              0,
              spendLimit - used - (await this.delegation.cost(run.id)),
            ),
          );
        }
        return {
          tenant: conf.tenantId,
          agent: conf.id,
          requestId: run.id === "background" ? undefined : run.id,
          spendLimit,
          budget: Number.isFinite(budget) ? budget : undefined,
          builtins: conf.config.builtins,
          keyScope: conf.config.keyScope,
          identity: {
            subject: (params?.endUser as string | undefined) ?? conf.config.subject,
            context: conf.config.context,
          },
          actor: params?.actor as string | undefined,
          bucket: (params?.bucket as string | undefined) ?? conf.config.bucket,
          mounts: (conf.config.mounts ?? []) as import("./files.ts").Mount[],
        };
      },
      {
        storage: this.ctx.storage,
        onWrite: async (file, scope) => {
          if (!scope.requestId)
            throw new Error("Image output has no executing request");
          await writtenFile(this.ctx.storage, scope.requestId, file);
        },
      },
    );
  }

export async function sourceIdentityImpl(this: AgentRuntime,
  api?: ToolExecutionApi) {
    const conf = await this.config(),
      run = await this.currentRun(api),
      params = "params" in run ? run.params : undefined;
    const issuer = this.env.AGENT_PUBLIC_URL || conf.runtimeOrigin;
    if (!issuer) throw new Error("Runtime public URL is not configured");
    const call = api ? await toolCallSite(api) : undefined;
    const lineage = await this.delegation.lineage(conf.id, run);
    if (call?.assistant !== undefined) {
      const pi = await this.harness.pi();
      await this.historyIndex.sync(await pi.root(BACKGROUND_CONTEXT));
      call.messageIndex = this.historyIndex.messageIndex(call.assistant);
    }
    return {
      issuer,
      toolFiles: (tool: string, refuse?: string) => {
        let budget = this.toolFileBudgets.get(run.id);
        if (!budget) { budget = { left: TOOL_FILE_LIMITS.runBytes }; this.toolFileBudgets.set(run.id, budget); }
        const requestId = run.id;
        const scope = { tenant: conf.tenantId, agent: conf.id, mounts: (conf.config.mounts ?? []) as Mount[], requestId };
        return new ToolFiles(this.env, { ...scope, tool, call: call?.toolCallId ?? String(api?.taskId ?? run.id), origin: issuer, refuse, budget,
          reference: path => new PromptAttachments(this.ctx.storage, this.env).reference(scope, path),
          onWrite: file => writtenFile(this.ctx.storage, requestId, file),
        });
      },
      ...(call ? { call } : {}),
      spawn: (tool: string, directive: unknown, currentApi: import('@earendil-works/pi-durable').ToolExecutionApi, context: import('@earendil-works/chord').Context) => this.delegation.toolSpawn(tool, directive, currentApi, context),
      progress: async (event: unknown) => {
        if (run.id !== "background") await this.emit({ type: "event", requestId: run.id, event });
      },
      intent: typeof params?.text === "string" ? params.text : undefined,
      elicit: !!(conf.config.humanInput || conf.config.builtins?.includes("ask_user") || this.attached.connected),
      claims: {
        tenant: conf.tenantId,
        agent: conf.id,
        definition: conf.config.definition,
        sub: conf.config.subject,
        ctx: conf.config.context,
        act: (params?.actor ??
          (params?.from as { id?: string } | undefined)?.id) as
          | string
          | undefined,
        req: run.id === "background" ? undefined : run.id,
        tcid: call?.toolCallId,
        // A channel's agent: tools see the channel, the conversation and who sent the message.
        ...(conf.config.type === "channel" ? { origin: await this.channels.origin(conf, run.id === "background" ? undefined : run.id) } : {}),
        ...(lineage ? { par: lineage.parent, root: lineage.root } : {}),
      },
    };
  }

export async function fileRequestIdImpl(this: AgentRuntime,
  conversationId?: Parameters<typeof hostExecutionRequest>[1]) {
    if (conversationId !== undefined) {
      const requestId = await hostExecutionRequest(
        await this.harness.pi(),
        conversationId,
      );
      if (requestId) return requestId;
    }
    const watch = await this.harness.session().watch();
    const live = watch.value.docs["pi.live"] as LiveState | undefined;
    const id =
      (await this.requestForInputs(live?.run?.inputs ?? [])) ?? this.active;
    if (!id) throw new Error("Files can be presented only during a run");
    return id;
  }
