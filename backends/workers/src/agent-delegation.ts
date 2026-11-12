import { madePlace, recordChildParent } from "./child-parent.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BadRequest, body } from "./validation.ts";
import { HumanInputs } from "./human.ts";
import { Directory } from "./control.ts";
import { attachChildComputers, forkChildComputers, releaseChildComputers } from "./computers/child-fork.ts";
import { computerSetup } from "./computers/agent-setup.ts";
import { Delegation } from "./delegation.ts";
import { resolveDefinition, provisionDefinition } from "./definitions.ts";
import { DelegationNotifications, type RuntimeNotice, type NoticeRequest, type WakeDecision } from "./delegation-notifications.ts";
import type { ChildProgressReport } from "./delegation.ts";
import { ChildOutbox, type ChildEnding, type Receipt } from "./ending-outbox.ts";
import type { Owner } from "../../../shared/owner.ts";
import { runSpend } from "./agent-spend.ts";
import { withSql, database } from "./postgres.ts";
import { Workspaces } from "./workspaces.ts";
import { Config, RequestRecord, canonical, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function admitDelegateWakeImpl(this: AgentRuntime,
  id: string): Promise<WakeDecision> {
    return this.wakeBudget.admit(id);
  }

export async function receiveAgentMessageImpl(this: AgentRuntime,
  request: NoticeRequest,
  notice: RuntimeNotice): Promise<unknown> {
    // Gone (deleted, expired): `{ gone: true }`, and the sender drops it rather than retrying what can never land.
    if (await this.gone("receiveAgentMessage", String(notice?.metadata?.kind ?? notice?.source?.kind ?? "message"))) return { gone: true };
    this.invalidateMaintenance();
    return this.notifications.deliverMessage(request, notice);
  }

/** A child's progress report, from its outbox. */
export async function receiveProgressImpl(this: AgentRuntime,
  report: ChildProgressReport): Promise<Receipt> {
    // A gone owner acknowledges it: its child's outbox drops the row.
    if (await this.gone("receiveProgress", "child")) return { accepted: true };
    this.invalidateMaintenance();
    return this.delegation.recordProgress(report);
  }

/** A child's ending, from its outbox: taken once, however often it is delivered. */
export async function receiveEndingImpl(this: AgentRuntime,
  ending: ChildEnding): Promise<Receipt> {
    // A gone owner acknowledges it: its child's outbox drops the row.
    if (await this.gone("receiveEnding", "child")) return { accepted: true };
    this.invalidateMaintenance();
    const receipt = await this.delegation.receiveEnding(ending);
    // The ending may owe a notification, or free a slot a start waits on: plan the next wake.
    this.ctx.waitUntil(this.arm().catch(() => {}));
    return receipt;
  }

/** Whether `id` is one of this agent's children (a browser token's `children` scope reads them by id). */
export async function hasChildImpl(this: AgentRuntime,
  id: string): Promise<boolean> {
    if (await this.gone("hasChild", "browser")) return false;
    return (await this.delegation.rows.byChild(id)) !== undefined;
  }

/** What an owner of either kind answers its children's outboxes with. */
type OwnerStub = { receiveEnding(ending: ChildEnding): Promise<Receipt>; receiveProgress(report: ChildProgressReport): Promise<Receipt> };
/**
 * Where this agent's runs' endings and progress go: their owners, by kind and id. A workflow is reached through the
 * `WORKFLOWS` namespace once the workflow object is deployed (its `receiveEnding`/`receiveProgress` are
 * workflow-agents.ts's); until then a delivery to one fails and the outbox retries it.
 */
export function ownerAgent(env: AgentRuntime["env"], owner: Owner): OwnerStub {
  if (owner.kind === "agent") return env.AGENTS.getByName(owner.id);
  const workflows = (env as { WORKFLOWS?: { getByName(name: string): OwnerStub } }).WORKFLOWS;
  if (!workflows) throw new Error(`No workflow objects on this runtime yet: ${owner.id}'s delivery waits`);
  return workflows.getByName(owner.id);
}

export function createOutbox(this: AgentRuntime): ChildOutbox {
  return new ChildOutbox({
    storage: this.ctx.storage,
    receiveEnding: (owner, ending) => ownerAgent(this.env, owner).receiveEnding(ending),
    receiveProgress: (owner, report) => ownerAgent(this.env, owner).receiveProgress(report),
    arm: (at) => this.arm(at),
  });
}

export function createNotifications(this: AgentRuntime): DelegationNotifications {
  return new DelegationNotifications({
    storage: this.ctx.storage,
    children: this.children,
    canLand: async () => !(await this.activity()).busy,
    asap: async () => (await this.config()).config.delegate?.notify === 'asap' && !this.delegation.waiting,
    stage: async (request, notice) => {
      if (await this.ctx.storage.get(reqKey(request.id))) return;
      const params = { ...request.params, whileRunning: 'queue' };
      await this.ctx.storage.put(reqKey(request.id), {
        id: request.id, method: 'prompt', params, fingerprint: canonical({ method: 'prompt', params }),
        state: 'running', startedAt: Date.now(), accepted: false, noticeQueued: true,
      } satisfies RequestRecord);
    },
    discard: async (request, skipped = 'wait_agent answered this sub-agent\'s ending already', carried = false) => {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(request.id));
      // A staged notice, once: a discard made again (after a crash) changes nothing and announces nothing. A carried
      // notice that was never staged gets its request recorded too, answered as carried, as on Node (where every
      // child's notification is a request).
      if (record?.state === 'completed' || (record && !record.noticeQueued) || (!record && !carried)) return;
      const params = { ...request.params, whileRunning: 'queue' };
      const base: RequestRecord = record ?? { id: request.id, method: 'prompt', params, fingerprint: canonical({ method: 'prompt', params }), state: 'running', startedAt: Date.now(), accepted: false };
      const done: RequestRecord = { ...base, state: 'completed', status: 'completed', endedAt: Date.now(),
        outcome: { result: { error: null, skipped } } };
      await this.ctx.storage.put(reqKey(request.id), done);
      await this.emit({ type: 'response', id: request.id, outcome: done.outcome });
    },
    wakeLimit: this.delegateWakeLimit ? Number(this.delegateWakeLimit) : undefined,
    submit: (request, notice, delivery) =>
      !delivery.run && delivery.stopped === 'aborted'
        ? this.admit(request, notice, delivery)
        : this.submit(request, notice, delivery),
    // The chain's root counts its wakes. A workflow's chain (its ids are wf_…) counts them at its child, the first agent
    // below it: a workflow has no notifications of its own to loop on.
    admitWake: (root, id) =>
      root === this.ctx.id.name || root.startsWith("wf_")
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
    children: this.children,
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
      if (parent) await recordChildParent(this.env, conf.tenantId, entry.id, parent.agent, parent.run, parent.place);
      if (parent && !entry.existingAgent && config.workspaceId === undefined) {
        const workspaces = new Workspaces(database(this.env));
        const inherited = await workspaces.current(conf.tenantId, "agent", parent.agent);
        if (inherited?.workspace) await workspaces.assign(conf.tenantId, "agent", entry.id, inherited.workspace, false, true);
      }
      return entry;
    },
    made: async () => {
      const conf = await this.config();
      return conf.config.type === "subagent" ? madePlace(this.env, conf.tenantId, conf.id) : undefined;
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
        const definition = await resolveDefinition(this.env, conf.tenantId, ref.definition, ref.revision);
        return { config: await provisionDefinition(this.env, conf.tenantId, { definition: definition.id, ...(ref.revision !== undefined ? { definitionRevision: ref.revision } : {}) }) as never,
          description: definition.spec.description };
      }
      const entry = await new Directory(this.env, conf.tenantId).get(
        ref.agent!,
      );
      if (!entry) throw new BadRequest("Unknown delegate agent");
      return { id: entry.id, config: entry.config as never };
    },
    fetch: (id, request) => this.env.AGENTS.getByName(id).fetch(request),
    submitChild: (id, request, placement) => this.env.AGENTS.getByName(id).admitDelegated(request, placement),
    cancelRequest: (id, requestId) =>
      this.env.AGENTS.getByName(id).cancelRequest(requestId),
    inheritComputer: async (parent, child, computer) => {
      const conf = await this.config();
      await attachChildComputers(this.env, conf.tenantId, parent, child, computer);
    },
    hasComputer: async () => this.hasNativeComputer(),
    forkComputer: async (batch) => {
      const conf = await this.config();
      return forkChildComputers(this.env, conf.tenantId, conf.id, batch, async () => computerSetup(this.env, conf), run => this.serializeComputer(run));
    },
    releaseComputer: async (child) => {
      const conf = await this.config();
      await releaseChildComputers(this.env, conf.tenantId, child);
    },
    emit: (event) => this.emit(event),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    notify: (child) => this.notifications.deliver(child),
    sendMessage: (id, request, notice) =>
      this.env.AGENTS.getByName(id).receiveAgentMessage(request, notice),
    reportProgress: (owner, report) => this.outbox.report(owner, report),
    retry: (afterMs = 1000) => this.arm(Date.now() + afterMs),
  });
}
