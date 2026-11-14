import { bashEnabled } from "./camelfs/bash.ts";
import { drainRepoMoves, repoMoveDeadline } from "./camelfs/notify.ts";
import { deliverRepoMoves } from "./repos/notify.ts";
import type { RepoEnv } from "./repos/registry.ts";
import type { AgentInvocation } from "./agent-invocation.ts";
export { configImpl } from './agent-config.ts';
import { ChildOutbox, deletedDeadline, settleDeleted } from "./ending-outbox.ts";
import { goneStart, stageMissedEndings } from "./agent-endings.ts";
import { checkGcDeadline, collectChecks, flushMonitors, monitorDeadline, monitorDue } from "./agent-monitors.ts";
import { flushScheduleOutcomes } from './schedule-outcomes.ts';
import { HttpError } from "./errors.ts";
import { expireDecisions } from "./inbox-decisions.ts";
import { restageInputMirrors } from "./agent-input-mirror.ts";
import { inputAdmissionDeadline } from "./input-admission.ts";
import { viaParent } from "./multi-agent-policy.ts";
import { childParent } from "./child-parent.ts";
import { type EventSubscription } from "./event-socket.ts";
import { withMoneyMetrics } from "./money-metrics.ts";
import { BadRequest } from "./validation.ts";
import { calendarPrompt } from "../../../src/calendar.ts";
import { ComputerService } from "./computers/service.ts";
import { newSchedule, deliverScheduledRun, type StoredSchedule as Schedule } from "./schedules.ts";
import { nextOccurrence, retryable, RETRY_DELAYS_MS } from "./schedule-policy.ts";
import { metric, errorClass, failure } from "./observability.ts";
import { TERMINAL_EVENTS_PREFIX } from "./event-log.ts";
import { scheduleError, type ScheduleToolsHost } from "./agent-schedules.ts";
import type { Config } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { purgeStart } from "./account-purge.ts";

/** Erase a revoked account's journal only after the normal shutdown completed. */
export async function purgeAccountDataImpl(this: AgentRuntime, invocation: AgentInvocation,
  tenant: string,
  id: string) {
    await this.admission;
    if (await purgeStart(this.ctx.storage, tenant, id) === "done") return;
    await Promise.all(this.pendingWaits.values());
    await this.eventsProcessed;
    for (;;) {
      const pending = await Promise.all(["billing:", "model-billing:", "image-billing:", "transcription-billing:"].map(prefix => this.ctx.storage.list({ prefix, limit: 1 })));
      if (pending.every(rows => rows.size === 0)) break;
      await this.flushBilling(invocation, true);
    }
    await this.env.COMPUTER_CONTAINERS?.getByName(this.ctx.id.toString()).purge();
    await this.closeWatchers(tenant, id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("deleted", true);
  }


export function scheduleToolsImpl(this: AgentRuntime): ScheduleToolsHost {
    return {
      create: input => this.createSchedule(input),
      list: async () => [...(await this.ctx.storage.list<Schedule>({ prefix: "schedule:", limit: 100 })).values()].filter(schedule => !schedule.monitor)
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)),
      cancel: async id => {
        const cancelled = await this.ctx.storage.delete(`schedule:${id}`);
        await this.arm();
        return cancelled;
      },
    };
  }

export async function createScheduleImpl(this: AgentRuntime,
  raw: unknown): Promise<Schedule> {
    if (
      (await this.ctx.storage.list({ prefix: "schedule:", limit: 100 })).size >=
      100
    )
      throw new BadRequest("At most 100 schedules per agent");
    const conf = await this.config();
    // A wake-up would start a turn its parent did not send: a sub-agent the runtime made has none (its builtin's either).
    if (conf.config.type === "subagent" && await childParent(this.env, conf.tenantId, conf.id)) throw viaParent(conf.id);
    const schedule = await newSchedule(this.env, conf.tenantId, conf.id, raw);
    if (schedule.sessionMode === "fresh" && !conf.config.definition) throw new HttpError(400, "Fresh schedules require an agent definition");
    await this.ctx.storage.put(`schedule:${schedule.id}`, schedule);
    await this.arm();
    return schedule;
  }

export async function armImpl(this: AgentRuntime, invocation: AgentInvocation,
  retry?: number) {
    this.invalidateMaintenance();
    const generation = this.maintenanceGeneration;
    const deleted = await this.ctx.storage.get("deleted");
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config && !deleted) return;
    const schedules = await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    });
    const pendingBilling =
      (await this.ctx.storage.list({ prefix: "billing:", limit: 1 })).size ||
      (await this.ctx.storage.list({ prefix: "image-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "transcription-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "model-billing:", limit: 1 }))
        .size;
    const pendingEvents = (
      await this.ctx.storage.list({ prefix: TERMINAL_EVENTS_PREFIX, limit: 1 })
    ).size;
    if (deleted) {
      // A deleted agent wakes only for what it still owes, never for the watchdog: a child row left ended and
      // unnotified (its notify refused by the deleted agent's own config) would otherwise wake it every second.
      const at = deletedDeadline({ billing: !!pendingBilling, events: !!pendingEvents, outbox: await this.outbox.deadline() });
      if (generation === this.maintenanceGeneration) this.maintenance = { at, tracksRuns: false };
      // Owing nothing, it goes quiet: no job, no alarm (settleDeleted re-reads the tombstone before removing either).
      if (await settleDeleted(this.ctx.storage, at, next => this.lifecycle.jobs.push({ id: "camel-wake", fn: "camel-wake", time: Math.max(Date.now() + 1, next) })) === "quiet")
        console.log(JSON.stringify({ type: "deleted_agent_quiet", agent: config?.id ?? this.ctx.id.name ?? null }));
      return;
    }
    if (!config) return;
    const records = await this.records();
    const pendingRuns = records.filter(record => record.accepted && record.state !== "completed");
    const children = await this.delegation.children();
    const recovering = records.some(record => record.state !== "completed" && !record.accepted && !record.heldForInput) ||
      this.cancellations.size > 0 ||
      (await Promise.all(pendingRuns.map(record => this.ctx.storage.get(`cancelled-request:${record.id}`)))).some(Boolean) ||
      !!await this.ctx.storage.get("resume-kept-queue") ||
      await this.notifications.pending() ||
      // A running child needs nothing from here: its ending comes by its own outbox. Only a child older code started
      // (no outbox) is asked, on each wake until it ends (Delegation.reconcileLegacy).
      // A child waiting on a person needs nothing either: its resumed run's ending comes the same way.
      children.some(child => (child.status === "running" && child.accepted && !child.outbox) ||
        (child.background && child.status !== "running" && child.accepted && !child.notified && child.landedBy !== "wait"));
    const next = Math.min(
      config?.expiresAt ?? Infinity,
      config
        ? ((await new ComputerService(this.env, config.tenantId).nextDeadline(
            config.id,
          )) ?? Infinity)
        : Infinity,
      ...[...schedules.values()].map((item) => item.monitor ? monitorDeadline(item) : item.retryAt ?? item.dueAt),
      inputAdmissionDeadline(records),
      retry ?? Infinity,
      (await this.ctx.storage.list({prefix:"schedule-outcome:",limit:1})).size ? Date.now()+60_000 : Infinity,
      await checkGcDeadline(this),
      pendingBilling ? Date.now() + 5000 : Infinity,
      pendingEvents ? Date.now() + 1000 : Infinity,
      await this.outbox.deadline() ?? Infinity,
      await repoMoveDeadline(this.ctx.storage) ?? Infinity,
      bashEnabled(this.env) ? this.bashSessions.deadline() : Infinity,
      records.some(record => record.method === 'configure' && record.state !== 'completed') ? Date.now() + 1000 : Infinity,
      await this.promptPreparations.deadline(),
      await this.batchQueue.deadline(config),
      await this.ctx.storage.get<number>("human-input-deadline") ?? Infinity,
      await this.ctx.storage.get<number>("decision-input-deadline") ?? Infinity,
      deleted || (config.expiresAt && config.expiresAt <= Date.now()) ? Infinity : await this.limits.deadline(invocation),
      ...this.ctx.getWebSockets().filter(socket => socket.readyState === 1).map(socket => (socket.deserializeAttachment() as EventSubscription)?.browser?.exp ?? Infinity),
    );
    const current = generation === this.maintenanceGeneration;
    if (current) this.maintenance = {
      at: next,
      tracksRuns: !recovering && !children.length && pendingRuns.length > 0 && pendingRuns.every(record => this.pendingWaits.has(record.id)),
    };
    // A slower planner must not replace a newer deadline with its stale reads.
    // If activity invalidated it without another plan, retain prompt recovery.
    const watchdog = current
      ? Math.min(next, pendingRuns.length || recovering ? Date.now() + (children.some(child => child.status === "running") ? 15_000 : 1000) : Infinity)
      : Math.min(Date.now() + 1000, this.maintenance?.at ?? Infinity);
    if (Number.isFinite(watchdog))
      await this.lifecycle.jobs.push({
        id: "camel-wake",
        fn: "camel-wake",
        time: Math.max(Date.now() + 1, watchdog),
      });
  }

export async function onStartImpl(this: AgentRuntime, invocation: AgentInvocation) {
    const began = Date.now(), stuck = startStuck(this, "onStart");
    try { return await withMoneyMetrics(this.env, () => this.restorePending(invocation)); }
    finally { clearTimeout(stuck); slowStart(this, "onStart", began); }
  }

/**
 * Startup runs inside the SDK's blockConcurrencyWhile, which resets the object after 30 s (on the pilot, a child woken by
 * a parent's send_message was reset so, 2026-11-07, and nothing said which step waited): a step over 2 s is logged,
 * with the time since the instance was made (the SDK's own start, Pi's harness, comes before onStart).
 */
const SLOW_START_STEP_MS = 2_000;
function slowStart(runtime: AgentRuntime, step: string, began: number) {
  const ms = Date.now() - began;
  if (ms > SLOW_START_STEP_MS) console.warn(JSON.stringify({ type: "agent_start_slow", step, ms, sinceConstructedMs: Date.now() - runtime.constructedAt }));
}
async function timed<T>(runtime: AgentRuntime, step: string, run: () => Promise<T>): Promise<T> {
  const began = Date.now(), stuck = startStuck(runtime, step);
  try { return await run(); } finally { clearTimeout(stuck); slowStart(runtime, step, began); }
}
/**
 * A step still running after 10 s is logged then (agent_start_stuck): a step that the 30 s reset ends never reaches
 * its slow log, so without this a reset says nothing of where it waited.
 */
export function startStuck(runtime: AgentRuntime, step: string) {
  return setTimeout(() => console.warn(JSON.stringify({ type: "agent_start_stuck", step, sinceConstructedMs: Date.now() - runtime.constructedAt })), 10_000);
}

export async function restorePendingImpl(this: AgentRuntime, invocation: AgentInvocation) {
    const sinceConstructed = Date.now() - this.constructedAt;
    if (sinceConstructed > SLOW_START_STEP_MS) console.warn(JSON.stringify({ type: "agent_start_slow", step: "before onStart", ms: sinceConstructed, sinceConstructedMs: sinceConstructed }));
    // A deleted or expired agent restores nothing: none of its work runs again, and each step reads its configuration,
    // which a gone agent refuses (410). It starts only to finish what it owes (wakeImpl's deleted path, or the expiry
    // there): billing, terminal events and its outbox, on the alarm arm() plans.
    const startConfig = await this.ctx.storage.get<Config>("configuration");
    if (await this.ctx.storage.get("deleted") || (startConfig?.expiresAt && startConfig.expiresAt <= Date.now())) {
      // Except a run's ending it still owes: one that ended (its record committed) as the object died, before the event
      // that stages its ending, is staged now and delivered, as for a live agent (stageMissedEndings reads storage, not
      // the configuration a gone agent refuses).
      await timed(this, "goneStart", () => goneStart(this));
      return;
    }
    this.configurationQueue.kick();
    await timed(this, "promptPreparations.sweep", () => this.promptPreparations.sweep(Date.now(), true));
    await timed(this, "resumeKeptQueue", () => this.resumeKeptQueue());
    await timed(this, "restoreCancellations", () => this.restoreCancellations(invocation));
    await timed(this, "restoreHostAdmissions", () => this.restoreHostAdmissions(invocation));
    await timed(this, "delegation.recover", () => this.delegation.recover());
    await timed(this, "notifications.drain", () => this.notifications.drain(invocation));
    await timed(this, "outbox", async () => { await stageMissedEndings(this, await this.records()); await this.outbox.flush(); });
    // Pi restores its own work on startup. Restore the adapter's result/receipt
    // waiters too, so completion is billed without requiring a client poll.
    for (const record of await this.records())
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
    if (
      (await this.ctx.storage.list({ prefix: "billing:", limit: 1 })).size ||
      (await this.ctx.storage.list({ prefix: "image-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "transcription-billing:", limit: 1 }))
        .size ||
      (await this.ctx.storage.list({ prefix: "model-billing:", limit: 1 })).size
    )
      this.ctx.waitUntil(this.flushBilling(invocation));
    // The Pi commit precedes stream emission. A crash in between leaves no outbox row.
    // Re-stage retained inputs, including settled ones, before flushing on every start.
    const mirrorConfig = await this.ctx.storage.get<Config>("configuration");
    if (mirrorConfig && !await this.ctx.storage.get("deleted") && (!mirrorConfig.expiresAt || mirrorConfig.expiresAt > Date.now()))
      await timed(this, "restageInputMirrors", () => restageInputMirrors(this));
    this.ctx.waitUntil(this.flushTerminalEvents());
    this.batchQueue.kick();
    // Recover a settlement whose admission kick was interrupted by an eviction.
    this.kickInputPrompts();
    await timed(this, "arm", () => this.arm(undefined, invocation));
    // A cold-start watchdog still performs the complete recovery pass. Its
    // waiters and maintenance schedule have only just been restored.
    this.invalidateMaintenance();
  }

export async function onJobImpl(this: AgentRuntime, invocation: AgentInvocation,
  context: { job: { fn: string } }) {
    return withMoneyMetrics(this.env, async () => {
      if (context.job.fn !== "camel-wake") return;
      const maintenance = this.maintenance;
      if (maintenance?.tracksRuns && Date.now() < maintenance.at &&
          !await this.notifications.pending() && (await this.delegation.children()).length === 0 &&
          !await this.limits.check(Date.now(), false, invocation) && this.maintenance === maintenance && Date.now() < maintenance.at) {
        await this.lifecycle.jobs.push({
          id: "camel-wake",
          fn: "camel-wake",
          time: Math.min(Date.now() + 1000, maintenance.at),
        });
        return;
      }
      await this.wake(invocation);
    });
  }

export async function wakeImpl(this: AgentRuntime, invocation: AgentInvocation) {
    if (await this.ctx.storage.get("deleted")) {
      // Each step logs and goes on: whatever fails, arm() below (in deletedWake) still plans the next wake for what is
      // owed, so a failed billing flush is retried rather than left until the account's purge.
      await this.flushBilling(invocation).catch(error => failure(this.env, "deleted_agent_billing_flush_failed", error));
      await this.flushTerminalEvents().catch(error => failure(this.env, "deleted_agent_events_flush_failed", error));
      await stageMissedEndings(this, await this.records()).catch(error => failure(this.env, "deleted_agent_stage_endings_failed", error));
      // A child deleted or expired mid-run staged a failed ending for its owner: deliver it, and keep retrying (the
      // alarm, re-armed for the outbox's next row) while the owner is unreachable. A gone owner acknowledges it.
      await ChildOutbox.deletedWake(this);
    this.ctx.waitUntil(flushScheduleOutcomes(this));
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as EventSubscription;
      if (subscription.browser && subscription.browser.exp <= Date.now()) this.closeBrowserSocket(socket);
    }
    const conf = await this.ctx.storage.get<Config>("configuration");
    // An expired agent starts no work: it goes straight to its expiry below (each of these reads its configuration,
    // which an expired agent refuses).
    if (!conf?.expiresAt || conf.expiresAt > Date.now()) {
      this.configurationQueue.kick();
      await this.promptPreparations.sweep();
      await this.resumeKeptQueue();
      await this.restoreCancellations(invocation);
    }
    if (conf)
      await this.serializeComputer(() =>
        new ComputerService(this.env, conf.tenantId).sweepAgent(conf.id),
      ).catch(() =>
        console.error(
          JSON.stringify({ type: "computer_cleanup_failed", agent: conf.id }),
        ),
      );
    if (conf?.expiresAt && conf.expiresAt <= Date.now()) {
      await this.promptPreparations.cancel();
      await this.markCancelledRequests();
      await this.abortExecutions(invocation);
      await this.ctx.storage.put("deleted", true);
      if (conf) await this.closeWatchers(conf.tenantId, conf.id);
      await this.delegation.destroy();
      await this.harness.session().abort();
      await this.cancelHumanInputs();
      // Unsettled turns are still charged from their durable receipts below.
      await this.flushBilling(invocation);
      await this.arm(undefined, invocation);
      return;
    }
    if (conf && bashEnabled(this.env)) await this.bashSessions.wake(conf, invocation);
    await restageInputMirrors(this);
    await this.flushBilling(invocation);
    await this.flushTerminalEvents();
    this.ctx.waitUntil(flushScheduleOutcomes(this));
    const expire = this.admission.then(() => this.closeHumanInputs(invocation, "expired"));
    this.admission = expire.catch(() => {});
    await expire;
    await expireDecisions(this, invocation);
    this.kickInputPrompts();
    await this.restoreHostAdmissions(invocation);
    // A call's live credit hold reserves its funds. Only check available credit
    // between calls; checking here could abort work that already reserved it.
    if (await this.limits.check(Date.now(), false, invocation)) await this.harness.session().abort();
    await this.delegation.recover();
    await this.notifications.drain(invocation);
    await drainRepoMoves(this.ctx.storage, async moves => deliverRepoMoves(this.env as RepoEnv, await this.config(), moves, request => this.fetch(invocation, request)))
      .catch(error => console.error("Repo watcher delivery failed", String(error)));
    await this.outbox.flush();
    this.batchQueue.kick();
    for (const record of await this.records()) {
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
      if (record.method === "prompt" && !record.accepted && !record.noticeQueued && !record.heldForInput) {
        try {
          await this.submit(invocation, {
            id: record.id,
            method: record.method,
            params: record.params,
          }, undefined, undefined, record.fingerprint);
        } catch {}
      }
    }
    const now = Date.now();
    // Messages monitors still owe the agent, then their due checks (agent-monitors.ts).
    await flushMonitors(this, invocation).catch(error => failure(this.env, "monitor_flush_failed", error));
    await collectChecks(this, now).catch(error => failure(this.env, "monitor_gc_failed", error));
    for (const [key, schedule] of await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    })) {
      if ((schedule.retryAt ?? schedule.dueAt) > now) continue;
      if (schedule.monitor) {
        await monitorDue(this, invocation, schedule, now).catch(error => failure(this.env, "monitor_due_failed", error));
        continue;
      }
      try {
        const occurrence = `schedule-${schedule.id}-${schedule.dueAt}`;
        await deliverScheduledRun(this.env, schedule, occurrence, input=>this.submit(invocation, input), work=>this.ctx.waitUntil(work));
        if (schedule.cron || schedule.calendar || schedule.everySeconds) {
          delete schedule.retryAt;
          schedule.failures = 0;
          schedule.attempts = 0;
          delete schedule.lastError;
          schedule.dueAt = nextOccurrence(schedule);
          await this.ctx.storage.put(key, schedule);
        } else await this.ctx.storage.delete(key);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const attempt = (schedule.attempts ?? 0) + 1;
        const delay = retryable(status)
          ? RETRY_DELAYS_MS[attempt - 1]
          : undefined;
        const next =
          schedule.cron || schedule.calendar || schedule.everySeconds
            ? nextOccurrence(schedule)
            : undefined;
          schedule.lastError = scheduleError(error);
        schedule.lastErrorAt = Date.now();
        if (status === 404 || status === 410)
          await this.ctx.storage.delete(key);
        else if (
          delay !== undefined &&
          (next === undefined || Date.now() + delay < next)
        ) {
          schedule.attempts = attempt;
          schedule.retryAt = Date.now() + delay;
          await this.ctx.storage.put(key, schedule);
        } else if (next !== undefined) {
          schedule.failures = (schedule.failures ?? 0) + 1;
          schedule.attempts = 0;
          delete schedule.retryAt;
          schedule.dueAt = next;
          await this.ctx.storage.put(key, schedule);
        } else await this.ctx.storage.delete(key);
        metric(
          this.env,
          "schedule_delivery_failed",
          { ScheduleDeliveryFailures: 1 },
          {
            ErrorClass: errorClass(error instanceof Error ? error.message : ""),
          },
        );
      }
    }
    await this.arm(undefined, invocation);
  }
