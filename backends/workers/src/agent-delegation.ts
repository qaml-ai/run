import { recordChildParent } from "./child-parent.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest, body } from "./validation.ts";
import { HumanInputs } from "./human.ts";
import { Directory } from "./control.ts";
import { inheritComputer } from "./computers/service.ts";
import { Delegation } from "./delegation.ts";
import { resolveDefinition, provisionDefinition } from "./definitions.ts";
import { DelegationNotifications, type RuntimeNotice, type NoticeRequest, type WakeDecision } from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import { runSpend } from "./agent-spend.ts";
import { withSql } from "./postgres.ts";
import { Config, RequestRecord, canonical, Child, reqKey } from "./agent-types.ts";
import { PiSubagents } from "./pi-subagents.ts";
import { agentMessage } from "./multi-agent-policy.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function admitDelegateWakeImpl(this: AgentRuntime,
  id: string): Promise<WakeDecision> {
    return this.wakeBudget.admit(id);
  }

export async function receiveAgentMessageImpl(this: AgentRuntime,
  request: NoticeRequest,
  notice: RuntimeNotice): Promise<unknown> {
    this.invalidateMaintenance();
    return this.notifications.deliverMessage(request, notice);
  }

export async function receiveAgentProgressImpl(this: AgentRuntime,
  report: ChildProgressReport): Promise<unknown> {
    this.invalidateMaintenance();
    return this.delegation.recordProgress(report);
  }

export async function hasBackgroundChildImpl(this: AgentRuntime,
  id: string): Promise<boolean> {
    return (await this.delegation.children()).some(child => child.background && child.id === id);
  }

export function createNotifications(this: AgentRuntime): DelegationNotifications {
  return new DelegationNotifications({
    storage: this.ctx.storage,
    canLand: async () => !(await this.activity()).busy,
    stage: async (request, notice) => {
      if (await this.ctx.storage.get(reqKey(request.id))) return;
      const params = { ...request.params, whileRunning: 'queue' };
      await this.ctx.storage.put(reqKey(request.id), {
        id: request.id, method: 'prompt', params, fingerprint: canonical({ method: 'prompt', params }),
        state: 'running', startedAt: Date.now(), accepted: false, noticeQueued: true,
      } satisfies RequestRecord);
    },
    discard: async request => {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(request.id));
      if (!record?.noticeQueued) return;
      const done: RequestRecord = { ...record, state: 'completed', status: 'completed', endedAt: Date.now(),
        outcome: { result: { error: null, skipped: 'wait_agent answered this sub-agent\'s ending already' } } };
      await this.ctx.storage.put(reqKey(request.id), done);
      await this.emit({ type: 'response', id: request.id, outcome: done.outcome });
    },
    wakeLimit: this.delegateWakeLimit ? Number(this.delegateWakeLimit) : undefined,
    submit: (request, notice, delivery) =>
      !delivery.run && delivery.stopped === 'aborted'
        ? this.admit(request, notice, delivery)
        : this.submit(request, notice, delivery),
    admitWake: (root, id) =>
      root === this.ctx.id.name
        ? this.admitDelegateWake(id)
        : this.env.AGENTS.getByName(root).admitDelegateWake(id),
    humanPending: async () => {
      const pi = await this.harness.pi(),
        root = await pi.root(BACKGROUND_CONTEXT);
      return Object.values(
        (await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT))?.requests ?? {},
      ).some((input) => input.answer === undefined);
    },
    retry: (at) => this.arm(at),
  });
}

export function createDelegation(this: AgentRuntime): Delegation {
  return new Delegation({
    storage: this.ctx.storage,
    secret: this.env.API_TOKEN,
    context: async (api) => {
      const conf = await this.config();
      const run = await this.currentRun(api);
      return { id: conf.id, config: conf.config as never, run: run as never };
    },
    remainingBudget: async (background, api): Promise<number | undefined> => {
      const conf = await this.config(),
        run = await this.currentRun(api);
      const spend = await this.agentSpend(conf);
      let left = spend ? spend.usd - spend.spent : Infinity;
      const perRun =
        "params" in run
          ? (run.params?.spendLimit as { usd?: number } | undefined)?.usd
          : undefined;
      if (!background && perRun !== undefined) {
        const used = await withSql(this.env, (sql) =>
          runSpend(sql, conf.tenantId, conf.id, run.id),
        );
        left = Math.min(
          left,
          perRun - used - (await this.delegation.cost(run.id)),
        );
      }
      return Number.isFinite(left) ? Math.max(0, left) : undefined;
    },
    create: async (config, key, parent) => {
      const conf = await this.config();
      const directory = new Directory(this.env, conf.tenantId);
      const entry = await directory.upsert(
        config,
        key,
        conf.runtimeOrigin,
      );
      if ("failed" in entry)
        throw Object.assign(new Error(entry.error), { status: entry.status });
      if (parent) await recordChildParent(this.env, conf.tenantId, entry.id, parent.agent, parent.run);
      return entry;
    },
    remove: async (id) => {
      const conf = await this.ctx.storage.get<Config>("configuration");
      if (!conf) return;
      const result = await new Directory(this.env, conf.tenantId).remove(id);
      if (result && typeof result === "object" && "failed" in result)
        throw new Error(result.error);
    },
    target: async (ref) => {
      const conf = await this.config();
      if (ref.definition) {
        const definition = await resolveDefinition(this.env, conf.tenantId, ref.definition);
        return { config: await provisionDefinition(this.env, conf.tenantId, { definition: definition.id }) as never,
          description: definition.spec.description };
      }
      const entry = await new Directory(this.env, conf.tenantId).get(
        ref.agent!,
      );
      if (!entry) throw new BadRequest("Unknown delegate agent");
      return { id: entry.id, config: entry.config as never };
    },
    fetch: (id, request) => this.env.AGENTS.getByName(id).fetch(request),
    cancelRequest: (id, requestId) =>
      this.env.AGENTS.getByName(id).cancelRequest(requestId),
    inheritComputer: async (parent, child) => {
      const conf = await this.config();
      await inheritComputer(this.env, conf.tenantId, parent, child);
    },
    emit: (event) => this.emit(event),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    notify: (child) => this.notifications.deliver(child),
    sendMessage: (id, request, notice) =>
      this.env.AGENTS.getByName(id).receiveAgentMessage(request, notice),
    reportProgress: (id, report) =>
      this.env.AGENTS.getByName(id).receiveAgentProgress(report),
    retry: (afterMs = 1000) => this.arm(Date.now() + afterMs),
  });
}

export async function delegateImpl(this: AgentRuntime,
  task: string,
  key: string,
  definition?: string): Promise<Child> {
    const conf = await this.config();
    const childKey = `${conf.id.slice(-24)}-${key.slice(-40)}`;
    const directory = new Directory(this.env, conf.tenantId);
    const base = definition ? await directory.get(definition) : null;
    if (definition && !base)
      throw Object.assign(new Error("Unknown delegate agent"), { status: 404 });
    if (
      definition &&
      conf.config.delegate?.agents &&
      !conf.config.delegate.agents.some(
        (target) => target.agent === definition || target.name === definition,
      )
    )
      throw Object.assign(new Error("Delegate is not allowed"), {
        status: 403,
      });
    const entry = await directory.upsert(
      {
        ...(base?.config ?? conf.config),
        name: `Child of ${conf.id}`,
        ttlSeconds: null,
      },
      childKey,
    );
    if ("failed" in entry)
      throw Object.assign(new Error(entry.error), { status: entry.status });
    await inheritComputer(this.env, conf.tenantId, conf.id, entry.id);
    const child: Child = {
      id: entry.id,
      key: childKey,
      requestId: `delegated-${key.slice(-60)}`,
      task,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`child:${key}`, child);
    const response = await this.env.AGENTS.getByName(entry.id).fetch(
      new Request("https://agent/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: child.requestId,
          method: "prompt",
          params: { text: task },
        }),
      }),
    );
    if (!response.ok)
      throw Object.assign(new Error("Child submission failed"), {
        status: response.status,
      });
    return child;
  }

/** The delegation tools this agent installs: the Pi spike's with AGENT_PI_SUBAGENTS=1, otherwise delegation.ts's. */
export async function delegationExtension(this: AgentRuntime, config: { delegate?: unknown; builtins?: string[]; type?: string }) {
  const settings = (config.delegate ?? {}) as Parameters<Delegation["toolsFor"]>[0];
  if (this.piSubagents)
    return { name: "camel.delegation", tools: this.piSubagents.tools(settings, config.builtins ?? [], await this.delegation.targetDescriptions(settings)), tasks: this.piSubagents.tasks() };
  return { name: "camel.delegation", tools: await this.delegation.toolsFor(settings, config.builtins ?? [], config.type === "subagent") };
}

/** SPIKE: Pi-owned subagents (pi-subagents.ts), only with AGENT_PI_SUBAGENTS=1. */
export function createPiSubagents(this: AgentRuntime): PiSubagents | undefined {
  if ((this.env as { AGENT_PI_SUBAGENTS?: string }).AGENT_PI_SUBAGENTS !== "1") return undefined;
  const web = ["web_search", "web_fetch", "ask_user", "ask_human"];
  const multi: Record<string, string[]> = { delegate: ["delegate"], agents: ["spawn_agent", "wait_agent", "list_agents", "send_message", "interrupt_agent"] };
  return new PiSubagents({
    pi: () => this.harness.pi(),
    context: async (api) => {
      const conf = await this.config();
      const run = await this.currentRun(api);
      return { id: conf.id, config: conf.config as never, run: run as never };
    },
    target: async (ref) => {
      const conf = await this.config();
      if (ref.definition) {
        const definition = await resolveDefinition(this.env, conf.tenantId, ref.definition);
        return { config: await provisionDefinition(this.env, conf.tenantId, { definition: definition.id }) as never, description: definition.spec.description };
      }
      const entry = await new Directory(this.env, conf.tenantId).get(ref.agent!);
      if (!entry) throw new BadRequest("Unknown delegate agent");
      return { id: entry.id, config: entry.config as never };
    },
    model: (config) => {
      const model = this.models.resolve(config.model as string | undefined);
      return { provider: model.provider, modelId: model.id };
    },
    tools: async (config) => {
      // A child can only use tools this agent installed: its files, code mode, the builtins it names, and the
      // delegation tools its own builtins give it. A definition's own MCP servers or computers are not available here.
      const builtins = (config.builtins as string[] | undefined) ?? [];
      const allowed = new Set([...this.workspaceToolNames, "codemode", "final_output", "report_progress", "send_message",
        ...web.filter(name => builtins.includes(name)), ...builtins.flatMap(name => multi[name] ?? [])]);
      const enabled = await this.enabledTools({ ...(await this.config()).config, ...config } as never);
      return { tools: enabled.tools.filter(tool => allowed.has(tool.name)) };
    },
    emit: (event) => this.emit(event),
    notify: (child) => this.notifications.deliver(child),
    messageParent: async (from, text, requestId) => {
      const conf = await this.config();
      const message = agentMessage({ agentId: from.agentId, name: from.name, root: conf.id }, text, "parent");
      return this.notifications.deliverMessage({ id: requestId, method: "prompt", params: { text, allowDisconnected: true, whileRunning: "followUp" } }, message.notice);
    },
  });
}
