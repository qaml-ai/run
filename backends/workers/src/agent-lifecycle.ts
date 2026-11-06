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

/** Erase a revoked account's journal only after the normal shutdown completed. */
export async function purgeAccountDataImpl(this: AgentRuntime,
  tenant: string,
  id: string) {
    await this.admission;
    const config = await this.ctx.storage.get<Config>("configuration");
    const deleted = await this.ctx.storage.get<boolean>("deleted");
    if (!deleted || config && (config.tenantId !== tenant || config.id !== id))
      throw new Error("Account purge requires the owned, deleted agent");
    await Promise.all(this.pendingWaits.values());
    await this.eventsProcessed;
    for (;;) {
      const pending = await Promise.all(["billing:", "model-billing:", "image-billing:", "transcription-billing:"].map(prefix => this.ctx.storage.list({ prefix, limit: 1 })));
      if (pending.every(rows => rows.size === 0)) break;
      await this.flushBilling(true);
    }
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
    const schedule = await newSchedule(this.env, conf.tenantId, conf.id, raw);
    await this.ctx.storage.put(`schedule:${schedule.id}`, schedule);
    await this.arm();
    return schedule;
  }

export async function armImpl(this: AgentRuntime,
  retry?: number) {
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
    const config = await this.ctx.storage.get<Config>("configuration");
    const pendingRun = (await this.records()).some(
      (record) => record.accepted && record.state !== "completed",
    );
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
      pendingRun ? Date.now() + 1000 : Infinity,
      (await this.records()).some(record => record.method === 'configure' && record.state !== 'completed') ? Date.now() + 1000 : Infinity,
      await this.promptPreparations.deadline(),
      await this.ctx.storage.get<number>("human-input-deadline") ?? Infinity,
      await this.limits.deadline(),
      ...this.ctx.getWebSockets().filter(socket => socket.readyState === 1).map(socket => (socket.deserializeAttachment() as EventSubscription)?.browser?.exp ?? Infinity),
    );
    if (Number.isFinite(next))
      await this.lifecycle.jobs.push({
        id: "camel-wake",
        fn: "camel-wake",
        time: Math.max(Date.now() + 1, next),
      });
  }

export async function onStartImpl(this: AgentRuntime) {
    return withMoneyMetrics(this.env, () => this.restorePending());
  }

export async function restorePendingImpl(this: AgentRuntime) {
    this.configurationQueue.kick();
    await this.promptPreparations.sweep(Date.now(), true);
    await this.resumeKeptQueue();
    await this.restoreCancellations();
    await this.restoreHostAdmissions();
    await this.delegation.recover();
    await this.notifications.drain();
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
  }

export async function onJobImpl(this: AgentRuntime,
  context: { job: { fn: string } }) {
    return withMoneyMetrics(this.env, async () => {
      if (context.job.fn === "camel-wake") await this.wake();
    });
  }

export async function wakeImpl(this: AgentRuntime) {
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
