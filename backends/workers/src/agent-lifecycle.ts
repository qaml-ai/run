import { MULTI_AGENT_LIMITS, viaParent } from "./multi-agent-policy.ts";
import { childParent } from "./child-parent.ts";
import { type EventSubscription } from "./event-socket.ts";
import { withMoneyMetrics } from "./money-metrics.ts";
import { BadRequest } from "./validation.ts";
import { calendarPrompt } from "../../../src/calendar.ts";
import { ComputerService } from "./computers/service.ts";
import { newSchedule, queueScheduleEmail, publishScheduleEmails, type StoredSchedule as Schedule } from "./schedules.ts";
import { nextOccurrence, retryable, RETRY_DELAYS_MS } from "./schedule-policy.ts";
import { metric, errorClass } from "./observability.ts";
import { TERMINAL_EVENTS_PREFIX } from "./event-log.ts";
import { scheduleError, type ScheduleToolsHost } from "./agent-schedules.ts";
import { Config } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { purgeStart } from "./account-purge.ts";

/** Erase a revoked account's journal only after the normal shutdown completed. */
export async function purgeAccountDataImpl(this: AgentRuntime,
  tenant: string,
  id: string) {
    await this.admission;
    if (await purgeStart(this.ctx.storage, tenant, id) === "done") return;
    await Promise.all(this.pendingWaits.values());
    await this.eventsProcessed;
    for (;;) {
      const pending = await Promise.all(["billing:", "model-billing:", "image-billing:", "transcription-billing:"].map(prefix => this.ctx.storage.list({ prefix, limit: 1 })));
      if (pending.every(rows => rows.size === 0)) break;
      await this.flushBilling(true);
    }
    await this.env.COMPUTER_CONTAINERS?.getByName(this.ctx.id.toString()).purge();
    await this.closeWatchers(tenant, id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("deleted", true);
  }

export async function configImpl(this: AgentRuntime) {
    if (await this.ctx.storage.get("deleted"))
      throw Object.assign(new Error("Agent deleted"), { status: 410 });
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config)
      throw Object.assign(new Error("Agent not found"), { status: 404 });
    if (config.expiresAt && config.expiresAt <= Date.now())
      throw Object.assign(new Error("Agent expired"), { status: 410 });
    return config;
  }

/** The schedule tools to offer: none for a sub-agent the runtime made, which has no schedules (`createScheduleImpl` refuses them). */
export async function offeredScheduleToolsImpl(this: AgentRuntime): Promise<ScheduleToolsHost | undefined> {
  const conf = await this.config();
  return conf.config.type === "subagent" && await childParent(this.env, conf.tenantId, conf.id) ? undefined : this.scheduleTools();
}

export function scheduleToolsImpl(this: AgentRuntime): ScheduleToolsHost {
    return {
      create: input => this.createSchedule(input),
      list: async () => [...(await this.ctx.storage.list<Schedule>({ prefix: "schedule:", limit: 100 })).values()]
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
    await this.ctx.storage.put(`schedule:${schedule.id}`, schedule);
    await this.arm();
    return schedule;
  }

export async function armImpl(this: AgentRuntime,
  retry?: number) {
    this.invalidateMaintenance();
    const generation = this.maintenanceGeneration;
    const config = await this.ctx.storage.get<Config>("configuration");
    if (!config) return;
    const deleted = await this.ctx.storage.get("deleted");
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
    const records = await this.records();
    const pendingRuns = records.filter(record => record.accepted && record.state !== "completed");
    const children = await this.delegation.children();
    const childKeys = new Set(children.map(child => child.key));
    const recovering = records.some(record => record.state !== "completed" && !record.accepted) ||
      this.cancellations.size > 0 ||
      (await Promise.all(pendingRuns.map(record => this.ctx.storage.get(`cancelled-request:${record.id}`)))).some(Boolean) ||
      !!await this.ctx.storage.get("resume-kept-queue") ||
      await this.notifications.pending() ||
      children.some(child => child.status === "running" ||
        (child.background && ((child.status === "input_required" && !child.cancelRequested &&
          !childKeys.has(`${child.key}:resume`) && Date.now() - child.createdAt < MULTI_AGENT_LIMITS.childTtlSeconds * 1000) ||
          (child.accepted && !child.notified && child.landedBy !== "wait"))));
    const next = Math.min(
      config?.expiresAt ?? Infinity,
      config
        ? ((await new ComputerService(this.env, config.tenantId).nextDeadline(
            config.id,
          )) ?? Infinity)
        : Infinity,
      ...[...schedules.values()].map((item) => item.retryAt ?? item.dueAt),
      retry ?? Infinity,
      pendingBilling ? Date.now() + 5000 : Infinity,
      pendingEvents ? Date.now() + 1000 : Infinity,
      records.some(record => record.method === 'configure' && record.state !== 'completed') ? Date.now() + 1000 : Infinity,
      await this.promptPreparations.deadline(),
      await this.ctx.storage.get<number>("human-input-deadline") ?? Infinity,
      deleted || (config.expiresAt && config.expiresAt <= Date.now()) ? Infinity : await this.limits.deadline(),
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
      ? Math.min(next, pendingRuns.length || recovering ? Date.now() + 1000 : Infinity)
      : Math.min(Date.now() + 1000, this.maintenance?.at ?? Infinity);
    if (Number.isFinite(watchdog))
      await this.lifecycle.jobs.push({
        id: "camel-wake",
        fn: "camel-wake",
        time: Math.max(Date.now() + 1, watchdog),
      });
  }

export async function onStartImpl(this: AgentRuntime) {
    const began = Date.now(), stuck = startStuck(this, "onStart");
    try { return await withMoneyMetrics(this.env, () => this.restorePending()); }
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

export async function restorePendingImpl(this: AgentRuntime) {
    const sinceConstructed = Date.now() - this.constructedAt;
    if (sinceConstructed > SLOW_START_STEP_MS) console.warn(JSON.stringify({ type: "agent_start_slow", step: "before onStart", ms: sinceConstructed, sinceConstructedMs: sinceConstructed }));
    this.configurationQueue.kick();
    await timed(this, "promptPreparations.sweep", () => this.promptPreparations.sweep(Date.now(), true));
    await timed(this, "resumeKeptQueue", () => this.resumeKeptQueue());
    await timed(this, "restoreCancellations", () => this.restoreCancellations());
    await timed(this, "restoreHostAdmissions", () => this.restoreHostAdmissions());
    await timed(this, "delegation.recover", () => this.delegation.recover());
    await timed(this, "notifications.drain", () => this.notifications.drain());
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
      this.ctx.waitUntil(this.flushBilling());
    this.ctx.waitUntil(this.flushTerminalEvents());
    await timed(this, "arm", () => this.arm());
    // A cold-start watchdog still performs the complete recovery pass. Its
    // waiters and maintenance schedule have only just been restored.
    this.invalidateMaintenance();
  }

export async function onJobImpl(this: AgentRuntime,
  context: { job: { fn: string } }) {
    return withMoneyMetrics(this.env, async () => {
      if (context.job.fn !== "camel-wake") return;
      const maintenance = this.maintenance;
      if (maintenance?.tracksRuns && Date.now() < maintenance.at &&
          !await this.notifications.pending() && (await this.delegation.children()).length === 0 &&
          !await this.limits.check(Date.now(), false) && this.maintenance === maintenance && Date.now() < maintenance.at) {
        await this.lifecycle.jobs.push({
          id: "camel-wake",
          fn: "camel-wake",
          time: Math.min(Date.now() + 1000, maintenance.at),
        });
        return;
      }
      await this.wake();
    });
  }

export async function wakeImpl(this: AgentRuntime) {
    if (await this.ctx.storage.get("deleted")) {
      await this.flushBilling();
      await this.flushTerminalEvents();
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      const subscription = socket.deserializeAttachment() as EventSubscription;
      if (subscription.browser && subscription.browser.exp <= Date.now()) this.closeBrowserSocket(socket);
    }
    this.configurationQueue.kick();
    await this.promptPreparations.sweep();
    await this.resumeKeptQueue();
    await this.restoreCancellations();
    const conf = await this.ctx.storage.get<Config>("configuration");
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
      await this.abortExecutions();
      await this.ctx.storage.put("deleted", true);
      if (conf) await this.closeWatchers(conf.tenantId, conf.id);
      await this.delegation.destroy();
      await this.harness.session().abort();
      await this.cancelHumanInputs();
      // Unsettled turns are still charged from their durable receipts below.
      await this.flushBilling();
      return;
    }
    await this.flushBilling();
    await this.flushTerminalEvents();
    const expire = this.admission.then(() => this.closeHumanInputs("expired"));
    this.admission = expire.catch(() => {});
    await expire;
    await this.restoreHostAdmissions();
    // A call's live credit hold reserves its funds. Only check available credit
    // between calls; checking here could abort work that already reserved it.
    if (await this.limits.check(Date.now(), false)) await this.harness.session().abort();
    await this.delegation.recover();
    await this.notifications.drain();
    for (const record of await this.records()) {
      if (record.accepted && record.state !== "completed")
        this.track(record.id);
      if (record.method === "prompt" && !record.accepted && !record.noticeQueued) {
        try {
          await this.submit({
            id: record.id,
            method: record.method,
            params: record.params,
          });
        } catch {}
      }
    }
    const now = Date.now();
    for (const [key, schedule] of await this.ctx.storage.list<Schedule>({
      prefix: "schedule:",
      limit: 100,
    })) {
      if ((schedule.retryAt ?? schedule.dueAt) > now) continue;
      try {
        const occurrence = `schedule-${schedule.id}-${schedule.dueAt}`;
        await queueScheduleEmail(this.env, schedule, occurrence);
        await this.submit({
          id: occurrence,
          method: schedule.code === undefined ? "prompt" : "execute",
          params:
            schedule.code === undefined
              ? {
                  text: schedule.calendar
                    ? calendarPrompt(
                        schedule.text!,
                        schedule.calendar,
                        schedule.dueAt,
                      )
                    : schedule.text,
                  allowDisconnected: true,
                }
              : { code: schedule.code, allowDisconnected: true },
        });
        if (schedule.email) await publishScheduleEmails(this.env);
        if (schedule.calendar || schedule.everySeconds) {
          delete schedule.retryAt;
          schedule.failures = 0;
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
          schedule.calendar || schedule.everySeconds
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
    await this.arm();
  }
