import { expiryAnswer, type Answer } from "./input-policy.ts";
import { steeringCanJoin, steeringJoined } from "./steering-placement.ts";
import { type Message, type AssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationView, type LiveState, LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { body } from "./validation.ts";
import { supersedesInput } from "../../../src/shared-agents.ts";
import { answerHuman, bindHumanInput, sameHumanAnswer, systemHumanAnswer, humanInputView, HumanInputs, resumedHumanTools, type HumanInput } from "./human.ts";
import { settledAlready } from "./input-policy.ts";
import { releaseTurn } from "./control.ts";
import { attachmentMessage } from "./prompt-attachments.ts";
import { publishScheduleEmails } from "./schedules.ts";
import { metric, errorClass } from "./observability.ts";
import { isUnbilledLimitMessage } from "./billing-run-stop.ts";
import { projectRunFailure } from "./run-failure.ts";
import { recordAgentActivity } from "./agent-activity.ts";
import { digest } from "./api-contract.ts";
import { journeyRunEnded } from "./journey.ts";
import { hostExecutionRequest, waitHostExecution } from "./host-execution.ts";
import { type RuntimeNotice, type NoticeDelivery } from "./delegation-notifications.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { type RuntimeLimit } from "./run-limits.ts";

import { enqueueTerminalEvents } from "./event-log.ts";
import { fileOutputs } from "./file-output.ts";
import { inputWebhook } from "./run-webhooks.ts";
import { Config, RequestRecord, BillingReceipt, reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

export async function currentRunImpl(this: AgentRuntime,
  api?: ToolExecutionApi) {
    if (api) {
      const id = await hostExecutionRequest(
        await this.harness.pi(),
        api.conversationId,
      );
      if (id) {
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
        if (!record) throw new Error("The executing request is missing");
        return record;
      }
    }
    return (
      (this.active
        ? await this.ctx.storage.get<RequestRecord>(reqKey(this.active))
        : undefined) ??
      (await this.records()).find((record) => record.state === "running") ?? {
        id: "background",
      }
    );
  }

export async function recordsImpl(this: AgentRuntime) {
    return [
      ...(
        await this.ctx.storage.list<RequestRecord>({ prefix: "request:" })
      ).values(),
    ].sort((a, b) => a.startedAt - b.startedAt);
  }

export async function markBeganImpl(this: AgentRuntime,
  id: string) {
    const started = await this.ctx.storage.transaction(async (tx) => {
      const record = await tx.get<RequestRecord>(reqKey(id));
      if (!record || record.began || record.state === 'completed') return false;
      record.began = Date.now();
      // Pi can start the next queued turn before the previous public outcome
      // finishes projection. Preserve that boundary instead of dating its end
      // after the next turn has already begun.
      if (!record.steeredInto && record.method !== 'execute') for (const previous of (await tx.list<RequestRecord>({ prefix: 'request:' })).values()) {
        if (previous.id !== id && previous.method !== 'execute' && previous.began && !previous.steeredInto && previous.state !== 'completed' && previous.startedAt <= record.startedAt)
          await tx.put(`turn-ended:${previous.id}`, record.began);
      }
      record.state = "running";
      await tx.put(reqKey(id), record);
      return true;
    });
    if (started) {
      await this.emit({
        type: "event",
        requestId: id,
        event: { type: "agent_start" },
      });
      await this.arm();
    }
  }

export async function observeImpl(this: AgentRuntime) {
    // Startup may itself observe restored host requests. An outside caller must
    // not cache a promise waiting for that startup, or both wait on each other.
    const pi = await this.harness.pi();
    return (this.observer ??= (async () => {
      const watch = await this.harness.session().watch();
      const root = await pi.root(BACKGROUND_CONTEXT);
      await this.historyIndex.sync(root);
      this.nextMessage = this.historyIndex.total();
      await root.commit(async (tx) => {
        await tx.doc(HumanInputs);
      }, BACKGROUND_CONTEXT);
      const human = (await pi.watchDoc(HumanInputs, BACKGROUND_CONTEXT))!;
      human.start(async (call) => {
        if (call.kind !== "value") return;
        const processing = this.eventsProcessed.then(() =>
          this.onHuman(call.value),
        );
        this.eventsProcessed = processing.catch(() => {});
        return processing;
      });
      // The initial window is a snapshot, not a batch of new messages.
      this.lastEntry = Math.max(
        0,
        ...watch.value.entries.map((entry) => Number(entry.id)),
      );
      const live = watch.value.docs["pi.live"] as LiveState | undefined;
      this.partial = (live?.generation?.message as AssistantMessage) ?? null;
      this.active = await this.requestForInputs(live?.run?.inputs ?? []);
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const processing = this.eventsProcessed.then(() =>
          this.onView(call.value),
        );
        this.eventsProcessed = processing.catch(() => {});
        return processing;
      });
    })());
  }

export async function requestForInputsImpl(this: AgentRuntime,
  inputs: readonly number[]): Promise<string | undefined> {
    const pi = await this.harness.pi();
    for (const input of inputs) {
      const submission = await pi.submission(
        input as never,
        BACKGROUND_CONTEXT,
      );
      const status = await submission?.status(BACKGROUND_CONTEXT);
      if (status?.requestId) {
        const record = await this.ctx.storage.get<RequestRecord>(
          reqKey(status.requestId),
        );
        if (record) await this.reconcileSteering(record, inputs);
        return (
          (await this.ctx.storage.get<string>(
            `resume-for:${status.requestId}`,
          )) ??
          record?.steeredInto ??
          status.requestId
        );
      }
    }
  }

export async function runningRequestImpl(this: AgentRuntime): Promise<{ owner: string; nativeRequest: string; resumeOwner?: string } | undefined> {
    const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const live = await pi.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
    for (const input of live?.run?.inputs ?? []) {
      const submission = await pi.submission(input, BACKGROUND_CONTEXT);
      const status = await submission?.status(BACKGROUND_CONTEXT);
      // A watch can still show an input after its final answer committed. The
      // submission is authoritative about whether this native run can take it.
      if (!status?.requestId || !steeringCanJoin(status)) continue;
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(status.requestId));
      const resumeOwner = await this.ctx.storage.get<string>(`resume-for:${status.requestId}`);
      const id = resumeOwner ?? record?.steeredInto ?? status.requestId;
      const owner = id === record?.id ? record : await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (owner && owner.state !== 'completed') {
        return { owner: id, nativeRequest: status.requestId, ...(resumeOwner ? { resumeOwner } : {}) };
      }
    }
    return undefined;
  }

export async function projectMessageImpl(this: AgentRuntime,
  id: string,
  message: Message,
  ended: boolean,
  member?: string) {
    if (message.role === "system") return;
    if (await isUnbilledLimitMessage(this.ctx.storage, message)) return;
    if (ended) this.historyIndex.changed();
    message = attachmentMessage(message);
    if (message.role === "user") {
      // A batch's other prompts (`member`) are messages of their own in the lead's turn, which opened with the lead's.
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(member ?? id));
      if (ended && !member)
        await this.emit({
          type: "event",
          requestId: id,
          event: { type: "turn_opened", index: this.nextMessage },
        });
      message = {
        ...message,
        requestId: member ?? id,
        ...(record?.metadata ? { metadata: record.metadata } : {}),
        ...(record?.params?.from ? { from: record.params.from } : {}),
      } as Message;
    }
    for (const event of this.messageProjection.events(message, ended))
      await this.emit({ type: "event", requestId: id, event });
    if (ended) this.nextMessage++;
  }

export async function reconcileSteeringImpl(this: AgentRuntime,
  record: RequestRecord,
  inputs: readonly number[]) {
    // The Node host keeps its logical turn open while draining steers, even if
    // the preceding native run just answered. Preserve that accepted ownership.
    const parent = record.steeredInto ? await this.ctx.storage.get<RequestRecord>(reqKey(record.steeredInto)) : undefined;
    const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
    const placement = await root.commit(async tx => {
      const current = await tx.submissionByRequest(root.id, record.piId ?? record.id);
      const previous = record.steeredInto ? await tx.submissionByRequest(root.id, parent?.piId ?? record.steeredInto) : undefined;
      const entry = current?.entry === undefined ? undefined : await tx.entry(current.entry);
      if (entry?.data && typeof entry.data === 'object' && Object.hasOwn(entry.data, 'logicalOwner')) return { owner: (entry.data as { logicalOwner: string | null }).logicalOwner };
      const joined = steeringJoined(current, previous, inputs.map(id => ({ id })), record.steerCommitted);
      return { joined };
    }, BACKGROUND_CONTEXT);
    if ('owner' in placement && placement.owner !== undefined) {
      await this.steeringOwner(record, placement.owner);
    } else if (placement.joined === false) {
      delete record.steeredInto;
      record.steer = 'queued';
      record.state = 'running';
      await this.ctx.storage.put(reqKey(record.id), record);
    }
  }

export async function steeringOwnerImpl(this: AgentRuntime,
  record: RequestRecord,
  owner: string | null) {
    if (owner) {
      record.steeredInto = owner;
      record.steerCommitted = true;
      record.steer = 'accepted';
    } else {
      delete record.steeredInto;
      delete record.steerCommitted;
      record.steer = 'queued';
    }
    await this.ctx.storage.put(reqKey(record.id), record);
  }

export async function onViewImpl(this: AgentRuntime,
  view: ConversationView) {
    const live = view.docs["pi.live"] as LiveState | undefined;
    // A paused Pi turn keeps its original input ID. New output belongs to its
    // admitted resume alias, including snapshots delivered just after answer().
    if (this.active)
      this.active =
        (await this.ctx.storage.get<string>(`resume-for:${this.active}`)) ??
        this.active;
    else
      this.active = (await this.records()).find(
        (record) => record.method === "resume" && record.state === "running",
      )?.id;
    // Input labels retain attribution when several turns share one callback.
    for (const entry of view.entries) {
      if (Number(entry.id) <= this.lastEntry) continue;
      if (entry.kind === "camel.context" || entry.kind === "pi.reset") {
        this.lastEntry = Number(entry.id);
        continue;
      }
      if ((entry.kind === 'camel.prompt' || entry.kind === 'camel.steer') && entry.data && typeof entry.data === 'object' && Object.hasOwn(entry.data, 'logicalOwner')) {
        const data = entry.data as { requestId: string; logicalOwner: string | null };
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(data.requestId));
        if (record) await this.steeringOwner(record, data.logicalOwner);
      }
      // A follow-up Pi placed with the run's first input, on an agent whose queue batches (batch-queue.ts): part of that
      // input's turn, whose stream carries its message. Its request ends with the run, as Pi settles it.
      // Read from the transcript (Pi's run that placed it), so a restart mid-batch reads it the same.
      const batch = entry.kind === "camel.prompt" ? await this.batchQueue.batchOf((entry.data as { requestId: string }).requestId) : [];
      const lead = batch[0], member = lead !== undefined && lead !== (entry.data as { requestId: string }).requestId ? (entry.data as { requestId: string }).requestId : undefined;
      if (member && lead) {
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(member));
        if (record && record.state !== "completed" && !record.batchedInto) await this.ctx.storage.put(reqKey(member), { ...record, batchedInto: lead });
        await this.emit({ type: "event", requestId: member, event: { type: "batch_taken", batchedInto: lead } });
      } else if (entry.kind === "camel.prompt") {
        const original = (entry.data as { requestId: string }).requestId;
        this.active =
          (await this.ctx.storage.get<string>(`resume-for:${original}`)) ??
          original;
        await this.markBegan(this.active);
      }
      if (entry.kind === "camel.steer") {
        const id = (entry.data as { requestId: string }).requestId;
        const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
        if (record && record.state !== 'completed') await this.reconcileSteering(record, live?.run?.inputs ?? []);
        if (record && record.state !== 'completed' && !record.steeredInto) {
          this.active = id;
          await this.markBegan(id);
        }
        if (record?.steeredInto && record.state !== "completed") {
          record.state = "completed";
          record.status = "completed";
          record.endedAt = Date.now();
          record.outcome = {
            result: { steeredInto: record.steeredInto },
          };
          await this.ctx.storage.put(reqKey(id), record);
          await this.emit({
            type: "event",
            requestId: id,
            event: { type: "steer_taken", id, steeredInto: record.steeredInto },
          });
          await this.emit({ type: "response", id, outcome: record.outcome });
          const conf = await this.config();
          await releaseTurn(this.env, conf.tenantId, conf.id, id);
          await this.env.TENANTS.getByName(conf.tenantId).release(
            `${conf.id}:${id}`,
          );
        }
      }
      const stamp = entry.data as { requestId?: string; source?: RuntimeNotice['source']; metadata?: Record<string, unknown> };
      if ((entry.kind === 'camel.prompt' || entry.kind === 'camel.steer') && stamp.source?.kind === 'agent' && stamp.metadata?.kind === 'message' && stamp.metadata.to === 'parent') {
        const record = stamp.requestId ? await this.ctx.storage.get<RequestRecord>(reqKey(stamp.requestId)) : undefined;
        await this.emit({ type: 'event', requestId: record?.steeredInto ?? stamp.requestId ?? this.active,
          event: { type: 'subagent_message', agentId: stamp.source.agentId, name: stamp.source.name, text: record?.params?.text ?? '' } });
      }
      if (this.active)
        for (const message of entry.model ?? [])
          await this.projectMessage(this.active, message, true, member);
      this.lastEntry = Number(entry.id);
    }
    const id = await this.requestForInputs(live?.run?.inputs ?? []);
    // No follow-ups waiting in Pi's inbox: prompts held for a batch can go now.
    const inbox = view.docs["pi.inbox"] as { items?: { mode: string }[] } | undefined;
    if (!inbox?.items?.some(item => item.mode === "followUp") && (await this.ctx.storage.list({ prefix: "batch-hold:", limit: 1 })).size) this.batchQueue.kick();
    this.partial = (live?.generation?.message as AssistantMessage) ?? null;
    if (id) {
      this.active = id;
      await this.markBegan(id);
      // Provider deltas are projected before Pi batches this live document.
    } else if (this.active) {
      const record = await this.ctx.storage.get<RequestRecord>(
        reqKey(this.active),
      );
      if (record?.state === "completed" && record.status !== "input_required")
        this.active = undefined;
    }
    if (live?.tools?.length) {
      const pi = await this.harness.pi();
      const inputs = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
      if (inputs && Object.values(inputs.requests).some(input => input.answer === undefined))
        await this.onHuman(inputs);
    }
  }

export async function onHumanImpl(this: AgentRuntime,
  doc: { requests: Record<string, HumanInput> }) {
    const pending = Object.entries(doc?.requests ?? {}).filter(
      ([, input]) => input.answer === undefined,
    );
    const owners = new Map<string, Array<[string, HumanInput]>>();
    const deadlines: number[] = [];
    for (const [key, input] of pending) {
      const id = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`)
        ?? this.active ?? (await this.currentRun()).id;
      if (await this.ctx.storage.get(`cancelled-request:${id}`)) continue;
      const entries = owners.get(id) ?? [];
      entries.push([key, input]);
      owners.set(id, entries);
    }
    for (const [id, entries] of owners) {
      const conf = await this.config();
      const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      const actor = record?.params?.actor as string | undefined ?? (record?.params?.from as { id?: string } | undefined)?.id;
      const shared = record?.sharedAgent ?? undefined;
      const bound = entries.map(([key, input]) => [key, bindHumanInput(input, id, actor, conf.config.humanInput, conf.expiresAt ?? null, record?.params?.from as import("./sender.ts").Sender | undefined, shared)] as const);
      deadlines.push(...bound.flatMap(([, input]) => input.expiresAt === undefined ? [] : [input.expiresAt]));
      if (bound.some(([, input], index) => input !== entries[index][1])) {
        const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
        await root.commit(async tx => {
          const doc = await tx.doc(HumanInputs);
          for (const [key, input] of bound) {
            const current = doc.requests[key];
            if (current && !current.policyBound) Object.assign(current, { requestId: input.requestId, responders: input.responders, inboxResponders: input.inboxResponders, ...(input.fixedResponders ? { fixedResponders: true as const } : {}), expiresAt: input.expiresAt, policyBound: true });
          }
        }, BACKGROUND_CONTEXT);
      }
      const inputs = bound.map(([key, input]) =>
        humanInputView(key, input, conf.id, id),
      );
      for (const input of inputs)
        if (!(await this.ctx.storage.get(`input-owner:${input.id}`))) {
          await this.ctx.storage.put(`input-owner:${input.id}`, id);
          await this.emit({
            type: "event",
            requestId: id,
            event: { type: "input_required", input },
          });
        }
      if (record?.state === "running") {
        // A host script waits on its own ToolTask, not the root model submission.
        // Keep that request live so answering resumes and settles the same task.
        if (record.method === "execute") {
          record.status = "input_required";
          await this.ctx.storage.put(reqKey(id), record);
          continue;
        }
        const live = (await this.harness.session().watch()).value.docs["pi.live"] as LiveState | undefined;
        const waiting = new Set(bound.map(([, input]) => input.toolCallId));
        // A code mode call waits on people once every call its script still has out does (its VM stops meanwhile:
        // codemode/sandbox.ts); calls already under way beside them finish first, as main's do.
        const scripts = new Set((live?.tools ?? []).filter(tool => tool.status !== "done" && !waiting.has(tool.callId)).filter(tool => {
          const out = (live?.nestedTools ?? []).filter(slot => slot.parentCallId === tool.callId && slot.status !== "done");
          return out.length > 0 && out.every(slot => waiting.has(slot.callId));
        }).map(tool => tool.callId));
        if (live?.tools?.some(tool => tool.status !== "done" && !waiting.has(tool.callId) && !scripts.has(tool.callId))) continue;
        const conf = await this.config();
        record.state = "completed";
        record.status = "input_required";
        record.endedAt = Date.now();
        const usage = await this.usageForRequest(record.piId ?? id);
        // What the model said beside the call that asks, as the Node runtime reports it.
        const said = usage.last && usage.last.stopReason !== "error"
          ? usage.last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() : "";
        record.outcome = {
          result: { stopped: "input_required", inputs, reply: said, messages: this.nextMessage, usage: this.requestUsage(record, usage),
            ...(usage.toolCalls?.length ? { toolCalls: usage.toolCalls.map(call => waiting.has(call.toolCallId) ? { ...call, ok: false, code: "input_required" } : call) } : {}),
            ...(usage.toolErrors?.length ? { toolErrors: usage.toolErrors } : {}),
            // Files presented before the question go out with it.
            ...(await fileOutputs(this.ctx.storage, id)),
          },
        };
        await this.ctx.storage.transaction(async (tx) => {
          await tx.put(reqKey(id), record);
          await tx.put(`billing:${id}`, {
            tenantId: conf.tenantId,
            agentId: conf.id,
            requestId: id,
            modelMetered: true,
            costMicros: 0,
            activeMs: Math.max(
              0,
              record.endedAt! - (record.began ?? record.endedAt!),
            ),
            startedAt: record.startedAt,
            subject: (record.params?.endUser as string | undefined) ?? conf.config.subject,
            bucket:
              (record.params?.bucket as string | undefined) ??
              conf.config.bucket,
            responses: 0,
          } satisfies BillingReceipt);
          await enqueueTerminalEvents(tx, id, record.outcome, false);
        });
        await this.flushBilling();
        await this.flushTerminalEvents();
        // Suspended from code, the agent holds no VM and runs nothing until the answer (main unloads it at once).
        if (scripts.size) await this.ctx.storage.put("unloaded-at", Date.now());
      }
    }
    if (deadlines.length) await this.ctx.storage.put("human-input-deadline", Math.min(...deadlines));
    else {
      await this.ctx.storage.delete("human-input-deadline");
      this.kickInputPrompts();
    }
    await this.arm();
  }

export function trackImpl(this: AgentRuntime,
  id: string) {
    if (this.pendingWaits.has(id)) return;
    this.invalidateMaintenance();
    const settled = this.settle(id, 0)
      .then(() => {})
      .catch(() => {})
      .finally(async () => {
        this.invalidateMaintenance();
        this.pendingWaits.delete(id);
        this.configurationQueue.kick();
        // A failed waiter leaves durable work to recover. Arm its retry after
        // removing the tracker so the watchdog performs the complete recovery.
        await this.arm();
      });
    this.pendingWaits.set(id, settled);
    this.ctx.waitUntil(settled);
  }

export async function settleImpl(this: AgentRuntime,
  id: string,
  waitMs: number): Promise<RequestRecord> {
    if (waitMs === 0 && await this.testStorage.get("test:fail-next-waiter")) {
      await this.testStorage.delete("test:fail-next-waiter");
      throw new Error("Injected result waiter interruption");
    }
    const record = await this.ctx.storage.get<RequestRecord>(reqKey(id));
    if (!record)
      throw Object.assign(new Error("Unknown request"), { status: 404 });
    if (record.state === "completed") {
      // Completion and its receipt commit together. A concurrent observer must
      // also wait for settlement to release the tenant's busy-agent slot.
      await this.flushBilling(true);
      return record;
    }
    // Held for a batch (batch-queue.ts): Pi has nothing of it to wait on until a release gives it.
    if (record.batchHeld) return this.batchQueue.settleHeld(record);
    if (!record.accepted) return record;
    if (record.method === "execute") {
      const signal = waitMs ? AbortSignal.timeout(waitMs) : undefined;
      let finished;
      try {
        finished = await waitHostExecution(
          await this.harness.pi(), record.task as never,
          signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
        );
      } catch (error) {
        if (signal?.aborted) {
          const latest = (await this.ctx.storage.get<RequestRecord>(reqKey(id))) ?? record;
          if (latest.state === "completed") await this.flushBilling(true);
          return latest;
        }
        throw error;
      }
      const { endedAt, ...result } = finished;
      if (this.env.TEST_MODEL === "1") {
        if (await this.testStorage.get("test:crash-host-settlement")) {
          await this.testStorage.put("test:host-finished-at", endedAt);
          await this.testStorage.put("test:host-stop-owner", this.instanceId);
          await this.testStorage.delete("test:crash-host-settlement");
        }
        if (await this.testStorage.get("test:host-stop-owner") === this.instanceId) return record;
      }
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") {
        await this.flushBilling(true);
        return current;
      }
      const completed: RequestRecord = {
        ...record,
        state: "completed",
        status: result.error ? "failed" : "completed",
        endedAt,
        outcome: result.error
          ? {
              error: result.error.message,
              ...(/may or may not have taken effect|connection lost|outcome may be unknown/i.test(
                result.error.message,
              )
                ? { code: "connection_lost", uncertain: true }
                : { code: result.error.kind }),
            }
          : { result: { ...result, ...(await fileOutputs(this.ctx.storage, id)) } },
      };
      const conf = await this.config();
      const terminal = await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<RequestRecord>(reqKey(id));
        if (latest?.state === "completed") return latest;
        await tx.put(reqKey(id), completed);
        await tx.put(`billing:${id}`, {
          tenantId: conf.tenantId, agentId: conf.id, requestId: id,
          modelMetered: true, costMicros: 0, activeMs: Math.max(0, completed.endedAt! - (record.began ?? record.startedAt)),
          startedAt: record.startedAt, responses: 0,
        } satisfies BillingReceipt);
        await enqueueTerminalEvents(tx, id, completed.outcome, false);
        return completed;
      });
      await this.flushBilling();
      await this.flushTerminalEvents();
      this.toolFileBudgets.delete(id);
      return terminal;
    }
    try {
      let result = await this.harness.wait(
        record.piId ?? id,
        waitMs ? { signal: AbortSignal.timeout(waitMs) } : undefined,
      );
      // Pi wakes result waiters as it commits; let its queued event batches reach
      // the adapter before exposing completion to an SDK stream.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.eventsProcessed;
      if (!record.steeredInto) {
        const joined = new Set<string>();
        for (;;) {
          const steers = (await this.records()).filter(
            (item) => item.steeredInto === id && !joined.has(item.id),
          );
          if (!steers.length) break;
          for (const steer of steers) {
            result = await this.harness.wait(steer.id);
            joined.add(steer.id);
          }
          await this.eventsProcessed;
        }
      }
      const current = await this.ctx.storage.get<RequestRecord>(reqKey(id));
      if (current?.state === "completed") {
        await this.flushBilling(true);
        return current;
      }
      if (await this.ctx.storage.get(`cancelled-request:${id}`)) await this.delegation.settleStopped(id);
      const usage = await this.usageForRequest(record.piId ?? id);
      const stored = await this.ctx.storage.get<Config>("configuration");
      const requestedOutput = record.params?.output;
      const outputValue = await this.ctx.storage.get(`output:${id}`);
      const limit = await this.ctx.storage.get<RuntimeLimit>(`run-limit:${id}`);
      const runUsage = this.requestUsage(record, usage);
      const modelFailed = usage.last?.stopReason === "error" || usage.last?.stopReason === "aborted";
      const runCompleted = result.status === "done" && !modelFailed;
      const outcome = limit
        ? { result: { ...limit, usage: runUsage } }
        : runCompleted
          ? {
              result: {
                // A resume closed without the model (its inputs superseded or expired) says nothing new.
                reply: record.method === "resume" && runUsage.responses === 0 ? "" : result.text ?? "",
                error: null,
                usage: runUsage,
                servedModel: usage.last
                  ? `${usage.last.provider}/${usage.last.model}`
                  : (record.billing?.model ?? stored?.config.model),
                ...(usage.toolCalls?.length ? { toolCalls: usage.toolCalls } : {}),
                ...(usage.toolErrors?.length ? { toolErrors: usage.toolErrors } : {}),
                ...(this.sourceFailures.length ? { sourceErrors: this.sourceFailures } : {}),
                replyIndex: usage.replyIndex,
                ...(await fileOutputs(this.ctx.storage, id)),
                ...(outputValue !== undefined
                  ? { output: outputValue }
                  : requestedOutput
                    ? {
                        error: "The model ended its turn without calling final_output, so the run has no output in its schema",
                        code: "output_missing",
                      }
                    : {}),
              },
            }
          : (projectRunFailure({
              aborted: !!(await this.ctx.storage.get(`cancelled-request:${id}`)),
              reason:
                usage.last?.errorMessage ??
                result.reason ??
                "Model operation failed",
              last: usage.last,
            }) ?? { error: "Model operation failed" });
      if ("result" in outcome && outcome.result) Object.assign(outcome.result, {
        usage: runUsage,
        messages: this.nextMessage,
        ...(usage.toolCalls?.length ? { toolCalls: usage.toolCalls } : {}),
        ...(usage.toolErrors?.length ? { toolErrors: usage.toolErrors } : {}),
      });
      // A prompt Pi placed with others on an agent whose queue batches (batch-queue.ts): Pi settled it with the turn's
      // answer. The turn's first input leads it and lists the others; each other carries the answer, names the first,
      // and has none of the turn's usage, charged once on the first.
      const batch = record.method === "prompt" ? await this.batchQueue.batchOf(record.piId ?? id) : [];
      const batchedInto = batch.length && batch[0] !== id ? batch[0] : undefined;
      if (batchedInto && "result" in outcome && outcome.result) {
        const { usage: _usage, toolCalls: _calls, toolErrors: _errors, files: _files, presented: _presented, ...answer } = outcome.result as Record<string, unknown>;
        outcome.result = { ...answer, batchedInto } as never;
      }
      let changed = false;
      const terminal = await this.ctx.storage.transaction(async (tx) => {
        const latest = await tx.get<RequestRecord>(reqKey(id));
        if (latest?.state === "completed") return latest;
        // Observation and acceptance can update this record while wait() is
        // pending. Merge under the transaction so their latest fields survive.
        const completed: RequestRecord = {
          ...(latest ?? current ?? record),
          state: "completed",
          endedAt: await tx.get<number>(`turn-ended:${id}`) ?? Date.now(),
          outcome,
          ...(batchedInto ? { batchedInto } : batch.length ? { batch: batch.slice(1) } : {}),
          status:
            !limit &&
            runCompleted &&
            (!requestedOutput || outputValue !== undefined)
              ? "completed"
              : "failed",
          ...(!runCompleted
            ? { error: usage.last?.errorMessage ?? result.reason ?? "Model operation failed" }
            : requestedOutput && outputValue === undefined && "result" in outcome
              ? { error: outcome.result?.error ?? undefined }
              : {}),
        };
        const conf = await tx.get<Config>("configuration");
        if (conf)
          await tx.put(`billing:${id}`, {
            tenantId: record.billing?.tenantId ?? conf.tenantId,
            agentId: record.billing?.agentId ?? conf.id,
            requestId: id,
            costMicros: 0,
            modelMetered: true,
            activeMs: Math.max(
              0,
              Date.now() - (latest?.began ?? record.began ?? Date.now()),
            ),
            startedAt: record.startedAt,
            responses: usage.responses,
            subject: (record.params?.endUser as string | undefined) ?? conf.config.subject,
            bucket:
              (record.params?.bucket as string | undefined) ??
              conf.config.bucket,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            model: record.billing?.model ?? conf.config.model,
          } satisfies BillingReceipt);
        await tx.put(reqKey(id), completed);
        await enqueueTerminalEvents(tx, id, outcome);
        changed = true;
        return completed;
      });
      // Receipt and terminal state commit together. A lost PG acknowledgement
      // only replays this immutable receipt; money remains one PG transaction.
      // A batch's follow-up is its first input's turn, counted once there.
      if (changed && stored && !batchedInto) await recordAgentActivity(this.env, stored.tenantId, stored.id, terminal);
      await this.flushBilling();
      if (changed && batchedInto) await this.flushTerminalEvents();
      if (changed && !batchedInto) {
        const conf = await this.ctx.storage.get<Config>("configuration");
        if (conf) await journeyRunEnded(this.env, conf.tenantId, { completed: terminal.status === 'completed', at: terminal.endedAt });
        metric(
          this.env,
          "turn_metrics",
          {
            Turns: 1,
            TurnDurationMs: terminal.endedAt! - terminal.startedAt,
            ModelResponses: usage.responses,
          },
          {
            Outcome: terminal.status ?? "completed",
            ErrorClass: errorClass(terminal.error),
            Model: terminal.billing?.model ?? "unknown",
            Provider: (terminal.billing?.model ?? "unknown").split("/")[0],
          },
        );
        await this.flushTerminalEvents();
        if (id.startsWith("schedule-")) await publishScheduleEmails(this.env);
      }
      this.toolFileBudgets.delete(id);
      return terminal;
    } catch (error) {
      if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        return record;
      throw error;
    }
  }

export async function submitImpl(this: AgentRuntime,
  input: unknown,
  notice?: RuntimeNotice,
  delivery?: NoticeDelivery,
  acceptedFingerprint?: string, member?: string) {
    // Configuration acceptance joins admission; its application runs separately
    // so the directory's /configuration round trip can acquire admission later.
    if (
      input &&
      typeof input === "object" &&
      (input as { method?: string }).method === "configure"
    )
      return this.configureRequest(input);
    const result = this.admission.then(() =>
      this.admit(input, notice, delivery, acceptedFingerprint, member),
    );
    this.admission = result.catch(() => {});
    return result;
  }

/** A late answer's 409: what became of the input (one that expired says so), as Node words it. */
function settledMessage(inputs: HumanInput[]) {
  const expired = inputs.find(input => input.answerDetail?.by.system === "expired");
  if (inputs.length === 1 && inputs[0].answerDetail) return settledAlready({ state: inputs[0].state ?? "answered", answer: inputs[0].answerDetail });
  return expired ? settledAlready({ state: "expired", answer: expired.answerDetail }) : "An input is already settled";
}

export async function answerHumanInputsImpl(this: AgentRuntime,
  answers: Array<{ id: string; body: unknown }>,
  via: "api" | "agent" | "channel",
  system?: "expired" | "superseded") {
    if (!answers.length || answers.length > 100 || new Set(answers.map(entry => entry.id)).size !== answers.length)
      throw Object.assign(new Error("Answer 1 to 100 different inputs"), { status: 400 });
    // Pi can resume a tool during this commit. Install all resume records first,
    // and hold projection until the whole answer batch has committed.
    let releaseProjection!: () => void;
    const gate = new Promise<void>(resolve => { releaseProjection = resolve; });
    const before = this.eventsProcessed;
    this.eventsProcessed = before.then(() => gate);
    await before;
    const created: RequestRecord[] = [];
    let conf: Config | undefined;
    try {
      const pi = await this.harness.pi(), root = await pi.root(BACKGROUND_CONTEXT);
      conf = await this.config();
      const snapshot = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
      const checked: Array<{ id: string; body: unknown; pending: HumanInput; owner: string | undefined; answer: { answer: string; state: NonNullable<HumanInput["state"]>; answerDetail: Answer } }> = [];
      for (const entry of answers) {
        const pending = snapshot?.requests[entry.id];
        if (!pending) throw Object.assign(new Error(`Unknown input ${entry.id}`), { status: 404 });
        // Failed policy binding must not turn a guest approval into an input anyone can answer.
        if (!system && !pending.policyBound) throw Object.assign(new Error("The input is not ready"), { status: 409 });
        const owner = pending.requestId ?? await this.ctx.storage.get<string>(`input-owner:${entry.id}`) ?? this.active;
        const view = humanInputView(entry.id, pending, conf.id, owner);
        if (!system && owner && await this.ctx.storage.get(`cancelled-request:${owner}`))
          throw Object.assign(new Error("This input is cancelled"), { status: 409, input: view });
        checked.push({ ...entry, pending, owner, answer: system ? (system === "expired" ? (() => { const answerDetail = expiryAnswer({ kind: pending.kind ?? "question", detail: pending.detail ?? {} }); return { answer: JSON.stringify(answerDetail.content ?? { action: "cancel" }), state: "expired" as const, answerDetail }; })() : systemHumanAnswer(system)) : answerHuman(pending, entry.body, via, pending.fixedResponders ? [] : conf.config.humanInput?.approvers as string[] | undefined) });
      }
      const fresh = checked.every(entry => entry.pending.answer === undefined);
      if (!fresh && !checked.every(entry => sameHumanAnswer(entry.pending, entry.answer)))
        throw Object.assign(new Error(settledMessage(checked.map(entry => entry.pending))), { status: 409, input: checked.length === 1 ? humanInputView(checked[0].id, checked[0].pending, conf.id, checked[0].owner) : checked.map(entry => humanInputView(entry.id, entry.pending, conf!.id, entry.owner)) });
      const selected = new Set(answers.map(entry => entry.id));
      const unresolved = new Set(await Promise.all(Object.entries(snapshot?.requests ?? {})
        .filter(([key, input]) => !selected.has(key) && input.answer === undefined)
        .map(async ([key, input]) => input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${key}`))));
      const requests: RequestRecord[] = [], resumeOwners = new Map<string, string>();
      for (const owner of new Set(checked.map(entry => entry.owner))) {
        if (!owner || unresolved.has(owner)) continue;
        const old = await this.ctx.storage.get<RequestRecord>(reqKey(owner));
        if (!old) throw Object.assign(new Error("The input's request is unavailable"), { status: 409 });
        if (old.method === "execute") {
          if (old.state === "completed" && fresh) throw Object.assign(new Error("The script has already ended"), { status: 409 });
          const resumed = old.state === "completed" ? old : { ...old, status: undefined };
          if (old.state !== "completed") await this.ctx.storage.put(reqKey(owner), resumed);
          requests.push(resumed);
          continue;
        }
        // An answer can arrive while sibling calls are still starting. Pi is
        // already running that turn; only a published suspension needs an alias.
        if (old.status !== "input_required") continue;
        const piId = old.piId ?? owner, resumeId = `resume_${(await digest(owner)).slice(0, 40)}`;
        let resumed = await this.ctx.storage.get<RequestRecord>(reqKey(resumeId));
        if (!resumed) {
          await this.flushBilling(true);
          if (!system) await this.admitRequest(conf, resumeId, old.params?.bucket as string | undefined, old.params?.endUser as string | undefined);
          resumed = { ...old, id: resumeId, piId, method: "resume", state: "running", status: undefined,
            outcome: undefined, startedAt: Date.now(), began: Date.now(), endedAt: undefined,
            usageBaseline: this.usageView(await this.usageForRequest(piId)) };
          await this.ctx.storage.put(reqKey(resumeId), resumed);
          await this.emit({ type: "event", requestId: resumeId, event: { type: "agent_start" } });
          // Where the resumed run's messages start in history, as Node's host says for every run (a prompt's comes with
          // its user message): a snapshot of the running turn carries them by index, and a watcher lines the stream up
          // with history by it.
          await this.emit({ type: "event", requestId: resumeId, event: { type: "turn_opened", index: this.nextMessage } });
          await this.ctx.storage.put(`resume-for:${piId}`, resumeId);
          created.push(resumed);
        }
        this.active = resumeId;
        requests.push(resumed);
        resumeOwners.set(resumed.id, owner);
      }
      const inputs: ReturnType<typeof humanInputView>[] = [];
      await root.commit(async tx => {
        const doc = await tx.doc(HumanInputs);
        for (const entry of checked) {
          const current = doc.requests[entry.id];
          if (current.answer !== undefined && !sameHumanAnswer(current, entry.answer))
            throw Object.assign(new Error(settledMessage([current])), { status: 409, input: humanInputView(entry.id, current, conf!.id, entry.owner) });
        }
        for (const entry of checked) {
          const current = doc.requests[entry.id];
          if (current.answer === undefined) Object.assign(current, entry.answer, { version: (current.version ?? 1) + 1 });
          inputs.push(humanInputView(entry.id, JSON.parse(JSON.stringify(current)), conf!.id, entry.owner));
        }
      }, BACKGROUND_CONTEXT);
      if (fresh && !system) for (const resumed of requests.filter(request => request.method === 'resume')) {
        const events = await resumedHumanTools(pi, checked.filter(entry => entry.owner === resumeOwners.get(resumed.id)).map(entry => entry.id), BACKGROUND_CONTEXT);
        for (const event of events) await this.emit({ type: 'event', requestId: resumed.id, event });
      }
      if (fresh) for (const entry of checked)
        await this.emit({ type: "event", requestId: entry.owner, event: { type: "input_resolved", id: entry.id, state: entry.answer.state, by: entry.answer.answerDetail.by } }, undefined,
          inputWebhook(conf, entry.owner ?? "", { id: entry.id, state: entry.answer.state }, true));
      for (const request of requests) this.track(request.id);
      if (requests.length) await this.arm();
      this.kickInputPrompts();
      return { status: fresh ? 202 : 200, inputs, requests };
    } catch (error) {
      for (const resume of created) {
        await this.ctx.storage.delete(reqKey(resume.id));
        await this.ctx.storage.delete(`resume-for:${resume.piId}`);
        await releaseTurn(this.env, conf!.tenantId, conf!.id, resume.id);
        await this.env.TENANTS.getByName(conf!.tenantId).release(`${conf!.id}:${resume.id}`);
      }
      throw error;
    } finally { releaseProjection(); }
  }

/**
 * Bring every pending input's expiry forward to `at` (never later than it was), and the alarm with it: the alarm then
 * expires them as it would at their own time. Returns how many were pending. Reached only through a subclass capability.
 */
export async function dueHumanInputsImpl(this: AgentRuntime, at: number) {
    const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
    let due = 0;
    await root.commit(async tx => {
      const doc = await tx.doc(HumanInputs);
      for (const input of Object.values(doc.requests)) if (input.answer === undefined) {
        const deadline = Math.min(input.expiresAt ?? at, at);
        if (deadline !== input.expiresAt) input.version = (input.version ?? 1) + 1;
        input.expiresAt = deadline;
        due++;
      }
    }, BACKGROUND_CONTEXT);
    if (due) {
      const deadline = await this.ctx.storage.get<number>("human-input-deadline");
      await this.ctx.storage.put("human-input-deadline", Math.min(deadline ?? at, at));
      await this.arm();
    }
    return due;
  }

export async function closeHumanInputsImpl(this: AgentRuntime,
  system: "expired" | "superseded", sender?: string, shared = false) {
    const pi = await this.harness.pi();
    const doc = await pi.snapshot(HumanInputs, BACKGROUND_CONTEXT);
    const answers = Object.entries(doc?.requests ?? {}).filter(([, input]) => input.answer === undefined &&
      (system === "expired" ? input.expiresAt !== undefined && input.expiresAt <= Date.now() : input.requestId !== undefined));
    const conf = await this.config();
    const selected: Array<{ id: string; body: { action: string } }> = [];
    for (const [id, input] of answers) {
      if (system === "superseded" && !supersedesInput({ kind: input.kind ?? "question", responders: input.responders ?? {} }, shared, sender)) continue;
      const owner = input.requestId ?? await this.ctx.storage.get<string>(`input-owner:${id}`);
      const record = owner ? await this.ctx.storage.get<RequestRecord>(reqKey(owner)) : undefined;
      // A user message supersedes the model's questions, not independent host scripts.
      if (system === "superseded" && record?.method === "execute") continue;
      selected.push({ id, body: { action: "cancel" } });
    }
    if (selected.length) await this.answerHumanInputs(selected, "api", system);
  }
