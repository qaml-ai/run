import { type LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cancelledHumanInput, HumanInputs } from "./human.ts";
import { releaseTurn } from "./control.ts";
import { keyServices } from "./security-services.ts";
import { startHostExecution, admitHostExecution, abortHostExecution, hostExecutionTask, HOST_EXECUTION_TOOL } from "./host-execution.ts";
import { RequestRecord, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function abortRequestsImpl(this: AgentRuntime,
  queued: 'cancel' | 'keep' = 'cancel',
  keepChildren = false) {
    if (queued === 'cancel') {
      await this.promptPreparations.cancel();
      const held = await this.ctx.storage.list({ prefix: 'held-steer:' });
      await this.ctx.storage.delete([...held.keys()]);
    }
    const pending = await this.harness.pending();
    const deferred = (await this.records()).filter(record => record.state !== 'completed' && record.configurationWait !== undefined);
    const cancelled = queued === 'keep' ? [] : [...new Set([
      ...pending.filter(item => item.status === 'queued').map(item => item.operationId),
      ...deferred.map(record => record.id),
    ])];
    const running = pending.filter(item => item.status === 'running').map(item => item.operationId);
    const keepTask = queued === 'keep'
      ? ((await this.harness.session().watch()).value.docs['pi.live'] as LiveState | undefined)?.run?.taskId
      : undefined;
    if (queued === 'cancel') await this.markCancelledRequests();
    else await this.ctx.storage.transaction(async tx => {
      for (const id of running) await tx.put(`cancelled-request:${id}`, 'keep-queue');
      if (keepTask !== undefined) await tx.put('resume-kept-queue', { taskId: keepTask });
    });
    if (queued === 'cancel') {
      await Promise.all([
        keepChildren ? Promise.resolve() : this.delegation.cancel(),
        (async () => {
          await this.cancelHumanInputs();
          await this.abortExecutions();
          await this.harness.session().abort();
        })(),
      ]);
      await this.notifications.abortPending();
    } else {
      for (const queued of pending.filter(item => item.status === 'queued')) {
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(queued.operationId));
        if (record?.steeredInto) {
          delete record.steeredInto;
          record.steer = 'queued';
          await this.ctx.storage.put(reqKey(record.id), record);
        }
      }
      for (const id of running) {
        await this.cancelHumanInputs(id);
        if (!keepChildren) await this.delegation.cancel(id);
      }
      await this.resumeKeptQueue();
    }
    const conf = await this.config();
    for (const id of cancelled) {
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (!record) continue;
      record.state = "completed";
      record.status = "failed";
      record.endedAt = Date.now();
      record.outcome = {
        result: { error: "Queued run cancelled", code: "cancelled" },
      };
      await this.ctx.storage.put(reqKey(id), record);
      await releaseTurn(this.env, conf.tenantId, conf.id, id);
      await this.env.TENANTS.getByName(conf.tenantId).release(
        `${conf.id}:${id}`,
      );
      await this.emit({ type: 'event', requestId: id, event: { type: 'run_cancelled', reason: 'stopped' } });
      await this.emit({ type: "response", id, outcome: record.outcome });
    }
    this.configurationQueue.kick();
    return { aborted: true, cancelled };
  }

export async function resumeKeptQueueImpl(this: AgentRuntime) {
    const intent = await this.ctx.storage.get<{ taskId: number }>('resume-kept-queue');
    if (!intent) return;
    const pi = await this.harness.pi();
    // A generation abort preserves the inbox but does not advance it. Repeating
    // the abort and the identified continue also finishes an interrupted stop.
    await pi.abortTask(intent.taskId as never, BACKGROUND_CONTEXT);
    await pi.waitForTask(intent.taskId as never, BACKGROUND_CONTEXT);
    if ((await this.harness.pending()).some(item => item.status === 'queued')) {
      const root = await pi.root(BACKGROUND_CONTEXT);
      await root.submit({ type: 'continue', requestId: `kept-queue-${intent.taskId}` }, BACKGROUND_CONTEXT);
    }
    await this.ctx.storage.delete('resume-kept-queue');
  }

/** Withdraw only this delegated input, including a cancellation that arrives before it. */
export async function cancelRequestImpl(this: AgentRuntime,
  id: string) {
    this.invalidateMaintenance();
    const cancel = this.admission.then(async () => {
      await this.ctx.storage.put(`cancelled-request:${id}`, true);
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (!record || (record.state === "completed" && record.status !== "input_required")) return false;
      this.resumeCancellation(record);
      return true;
    });
    this.admission = cancel.catch(() => {});
    const cancelled = await cancel;
    return cancelled;
  }

export function resumeCancellationImpl(this: AgentRuntime,
  record: RequestRecord) {
    if (this.cancellations.has(record.id)) return;
    this.cancellations.add(record.id);
    // A child tool may be waiting on its parent's admission queue. Acknowledge
    // the durable cancellation before draining tools or calling another object.
    const work = (async () => {
      await this.cancelHumanInputs(record.id);
      if (record.method === "execute")
        await abortHostExecution(await this.harness.pi(), record.id);
      else await this.harness.session().abort(record.piId ?? record.id);
      await this.delegation.cancel(record.id);
      if (record.method === "execute" && !record.accepted)
        await this.cancelHostIntent(record);
      else this.track(record.id);
    })()
      .catch(async () => {
        await this.arm(Date.now() + 1000);
      })
      .finally(() => this.cancellations.delete(record.id));
    this.ctx.waitUntil(work);
  }

export async function restoreCancellationsImpl(this: AgentRuntime) {
    for (const record of await this.records()) {
      if (record.state === "completed" && record.status !== "input_required") continue;
      const cancelled = await this.ctx.storage.get(`cancelled-request:${record.id}`);
      if (cancelled && record.noticeQueued) {
        await this.notifications.abortPending();
        continue;
      }
      if (cancelled === 'keep-queue') this.track(record.id);
      else if (cancelled) this.resumeCancellation(record);
    }
  }

export async function abortExecutionsImpl(this: AgentRuntime) {
    const pi = await this.harness.pi();
    for (const record of await this.records())
      if (record.method === "execute" && record.state !== "completed") {
        await abortHostExecution(pi, record.id);
        if (!record.accepted) await this.cancelHostIntent(record);
      }
  }

export async function markCancelledRequestsImpl(this: AgentRuntime) {
    for (const record of await this.records())
      if (record.state !== "completed" || record.status === "input_required")
        await this.ctx.storage.put(`cancelled-request:${record.id}`, true);
  }

export async function cancelHostIntentImpl(this: AgentRuntime,
  record: RequestRecord) {
    // Pi may have committed the task before the adapter's acceptance write was
    // interrupted. Cancel that real work through its normal receipt path.
    const pi = await this.harness.pi(), task = await hostExecutionTask(pi, record.id);
    if (task !== undefined) {
      const latest = (await this.ctx.storage.get<RequestRecord>(reqKey(record.id))) ?? record;
      if (latest.state === "completed") return;
      await this.ctx.storage.put(reqKey(record.id), { ...latest, task: Number(task), accepted: true, state: "running" });
      await abortHostExecution(pi, record.id);
      await this.settle(record.id, 0);
      return;
    }
    const completed = { ...record, state: "completed" as const, status: "failed", endedAt: Date.now(),
      outcome: { error: "Execution aborted", result: { code: "aborted" } } };
    await this.ctx.storage.put(reqKey(record.id), completed);
    if (record.admitted) {
      const conf = await this.config();
      await releaseTurn(this.env, conf.tenantId, conf.id, record.id);
      await this.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${record.id}`);
    }
    await this.emit({ type: "response", id: record.id, outcome: completed.outcome });
  }

export async function cancelHumanInputsImpl(this: AgentRuntime,
  requestId?: string) {
    const pi = await this.harness.pi();
    const snapshot = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
    const cancelled: Array<{ key: string; owner?: string }> = [];
    for (const [key, input] of Object.entries(snapshot?.requests ?? {})) {
      const owner = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`);
      if (input.answer === undefined && (requestId === undefined || owner === requestId))
        cancelled.push({ key, owner });
    }
    if (!cancelled.length) return;
    await pi.commit(async tx => {
      const doc = await tx.doc(HumanInputs);
      for (const { key } of cancelled) doc.requests[key] = cancelledHumanInput(doc.requests[key]);
    }, BACKGROUND_CONTEXT);
    for (const { key, owner } of cancelled)
      await this.emit({ type: "event", requestId: owner, event: { type: "input_resolved", id: key, state: "cancelled" } });
  }

export async function startHostRequestImpl(this: AgentRuntime,
  intent: RequestRecord) {
    if (await this.ctx.storage.get(`cancelled-request:${intent.id}`)) {
      await abortHostExecution(await this.harness.pi(), intent.id);
      await this.cancelHostIntent(intent);
      return (await this.ctx.storage.get<RequestRecord>(reqKey(intent.id)))!;
    }
    if (!intent.accepted) {
      const conf = await this.config();
      const { accounts } = await keyServices(this.env);
      const limit = await accounts.runLimit(conf.tenantId);
      if (limit) throw typeof limit === "string" ? Object.assign(new Error(limit), { status: 402, code: "SPEND_LIMIT" }) : limit;
      if (!intent.admitted) {
        await this.admitRequest(conf, intent.id);
        intent.admitted = true;
        await this.ctx.storage.put(reqKey(intent.id), intent);
      }
    }
    if (await this.ctx.storage.get(`cancelled-request:${intent.id}`)) {
      await abortHostExecution(await this.harness.pi(), intent.id);
      await this.cancelHostIntent(intent);
      return (await this.ctx.storage.get<RequestRecord>(reqKey(intent.id)))!;
    }
    const record = await admitHostExecution(this.ctx.storage, reqKey(intent.id), intent, async saved => {
      const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
      const tool = this.availableTools.find(tool => tool.name === HOST_EXECUTION_TOOL)!;
      const { code, timeoutMs, maxOutputCharacters } = saved.params!;
      if (saved.began === undefined) {
        saved.began = Date.now();
        await this.ctx.storage.put(reqKey(saved.id), saved);
      }
      const task = await startHostExecution(pi, root, saved.id, { code, timeoutMs, maxOutputCharacters }, tool);
      if (this.env.TEST_MODEL === "1" && await this.testStorage.get("test:crash-host-acceptance")) {
        await this.testStorage.delete("test:crash-host-acceptance");
        await this.testStorage.put("test:host-unaccepted-task", Number(task));
        throw Object.assign(new Error("Injected interruption after native host admission"), { status: 503 });
      }
      return Number(task);
    });
    this.track(record.id);
    return record;
  }

export async function restoreHostAdmissionsImpl(this: AgentRuntime) {
    for (const record of await this.records())
      if (record.method === "execute" && !record.accepted && record.state !== "completed")
        await this.startHostRequest(record);
  }
