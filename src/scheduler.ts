import { cronInput, nextCron, freshCronAllowed, type Cron } from "./core/cron.ts";
import { calendarInput, nextCalendar, type Calendar } from "./calendar.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { historyNoneIgnored } from "./history-none.ts";
import { HttpError } from "./http.ts";
import { viaParent } from "./multi-agent.ts";
import { underClaim, type Claim } from "./ownership.ts";
import { transaction } from "./db.ts";
import { beforeCheck, checkRequest, checkRequestId, checkResult, monitorInput, newMonitor, settleCheck, wakeRetryable, MONITOR_CAP_ERROR, MONITOR_LIMITS, type Monitor, type MonitorWake } from "../shared/monitors.ts";

/**
 * Durable timers that wake agents with a prompt, on any node. Each schedule is a
 * row in `schedules`; a node claims due rows with `FOR UPDATE SKIP LOCKED`, so one
 * node delivers each wake-up, and a claim left by a crashed node lapses after a
 * minute. Delivery submits a request whose id is derived from the schedule and due
 * time, so a repeated delivery (after a crash) is a no-op.
 *
 * The API writes schedules from any node, so they are kept consistent by their own
 * conditions: creates for one agent take turns (an advisory lock), so its cap holds,
 * and a scan's claim is a token of its own, so only the scan that took a wake-up
 * moves it on, even after its node restarted under the same name. A delivery that fails is retried after 1, 5 and 15
 * minutes (sooner than a repeating schedule's next occurrence), unless the refusal is one a retry cannot change (a
 * spend limit's 402, say); then that occurrence is given up: a repeating schedule moves to its next one, recording the
 * failure on the schedule (`failures`, `lastError`), and a one-off one is dropped. An agent's own
 * routes, served by its owner, also pass the owner's claim: a node that lost the
 * agent then changes none of its schedules.
 */
/**
 * A wake-up either prompts the agent (`text`) or runs sandboxed code with its tools (`code`). Every wake-up sees the
 * agent's history: a schedule's `history: "none"` (stored by earlier releases, or still sent) is accepted and ignored.
 */
export interface Schedule {
  id: string; agent: string; tenant: string; text?: string; code?: string;
  dueAt: number; everySeconds?: number; calendar?: Calendar; cron?: Cron; sessionMode?: "continue" | "fresh"; spendLimit?: { usd: number }; mounts?: {volumeId?:string;path?:string;mode?:"ro"|"rw";workspace?:boolean;subpath?:string;notify?:boolean}[]; email?: ScheduleEmail; createdAt: number;
  /** Occurrences in a row whose delivery was given up, and why the latest attempt failed: until a delivery succeeds. */
  failures?: number; lastError?: string; lastErrorAt?: number;
  /** A monitor (shared/monitors.ts): `code` is its check, run every `everySeconds`; its state and counters are here. */
  monitor?: Monitor;
}
export interface ScheduleEmail { to: string; subject: string; format?: "text" | "markdown" | "html" }
export function scheduleEmail(value: any): ScheduleEmail {
  if (!value || !z.email().safeParse(value.to).success || typeof value.subject !== "string" || !value.subject.trim() || value.subject.length > 200 || /[\r\n]/.test(value.subject)) throw new Error("email needs a valid to address and a subject (1–200 characters, one line)");
  if (value.format !== undefined && !["text", "markdown", "html"].includes(value.format)) throw new Error("email format must be text, markdown, or html");
  return { to: value.to, subject: value.subject.trim(), ...(value.format !== undefined ? { format: value.format } : {}) };
}
export type Deliver = (schedule: Schedule, requestId: string) => Promise<unknown>;
/** Queue a message to an agent (a monitor's fire): the same submission a schedule's delivery makes. */
export type Wake = (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<unknown>;

/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_TIMEOUT_MS = 60_000;
const CLAIM_BATCH = 100;
/** How long after each failed delivery of an occurrence it is tried again; past the last, it is given up. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Failures a retry may fix: no status (the network, a crash), a timeout, a conflict, a rate limit, or a server error. */
const retryable = (status: number | undefined) => status === undefined || status >= 500 || [408, 409, 425, 429].includes(status);
export const MIN_REPEAT_SECONDS = 60;
const COLUMNS = "id, agent, tenant, text, code, history, due_at, every_seconds, calendar, cron, session_mode, spend_limit, mounts, email, created_at, failures, last_error, last_error_at, monitor";
const schedule = (row: any): Schedule => ({
  ...(row.mounts ? {mounts:row.mounts} : {}), ...(row.cron ? {cron:row.cron} : {}), sessionMode: row.session_mode ?? "continue", ...(row.spend_limit ? {spendLimit:row.spend_limit} : {}), id: row.id, agent: row.agent, tenant: row.tenant, ...(row.calendar ? { calendar: row.calendar } : {}), ...(row.email ? { email: row.email } : {}), ...(row.text !== null ? { text: row.text } : {}), ...(row.code !== null ? { code: row.code } : {}),
  dueAt: row.due_at, ...(row.every_seconds !== null ? { everySeconds: row.every_seconds } : {}), createdAt: row.created_at,
  ...(row.failures ? { failures: row.failures } : {}), ...(row.last_error !== null ? { lastError: row.last_error, lastErrorAt: Number(row.last_error_at) } : {}),
  ...(row.monitor ? { monitor: row.monitor } : {}),
});

export class Scheduler {
  readonly db: Db;
  readonly node: string;
  private readonly deliver: Deliver;
  private readonly emailEnabled: boolean;
  private readonly canEmail?: (tenant: string, to: string) => Promise<boolean>;
  /** Other due work the scan takes care of: human input past its expiry. */
  private readonly also?: (now: number) => Promise<unknown>;
  private readonly wake?: Wake;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(options: { db: Db; node: string; deliver: Deliver; emailEnabled?: boolean; canEmail?: (tenant: string, to: string) => Promise<boolean>; also?: (now: number) => Promise<unknown>; wake?: Wake }) {
    this.wake = options.wake;
    this.db = options.db;
    this.node = options.node;
    this.deliver = options.deliver;
    this.emailEnabled = options.emailEnabled ?? false;
    this.canEmail = options.canEmail;
    this.also = options.also;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "scheduler_scan_failed", error: String(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async create(input: { agent: string; tenant: string; text?: string; code?: string; history?: string; dueAt: number; everySeconds?: number; calendar?: Calendar; cron?: Cron; sessionMode?: "continue" | "fresh"; spendLimit?: { usd: number }; mounts?: {volumeId?:string;path?:string;mode?:"ro"|"rw";workspace?:boolean;subpath?:string;notify?:boolean}[]; email?: ScheduleEmail }, claim?: Claim): Promise<Schedule> {
    validateScheduleMode(input);
    if (input.sessionMode === "fresh" && !(await this.db.query("select 1 from agents where id=$1 and tenant=$2 and header->'definition' is not null", [input.agent,input.tenant])).rowCount) throw new HttpError(400, "Fresh schedules require an agent definition");
    if (input.calendar) { input = { ...input, calendar: calendarInput(input.calendar) }; if (input.everySeconds !== undefined) throw new Error("Use calendar or everySeconds, not both"); }
    if (input.email) { if (!this.emailEnabled) throw new Error("Scheduled email is not enabled on this runtime"); input = { ...input, email: scheduleEmail(input.email) }; if (input.code !== undefined) throw new Error("Email delivery requires a text schedule"); }
    if (input.email && this.canEmail && !await this.canEmail(input.tenant, input.email.to)) throw new HttpError(403, "Use your sign-in email or a verified billing recipient for scheduled reports");
    const content = input.text ?? input.code;
    if ((input.text === undefined) === (input.code === undefined) || typeof content !== "string" || !content.trim() || content.length > 32_000) throw new Error("Give exactly one of text or code (1–32000 characters)");
    if (!Number.isFinite(input.dueAt)) throw new Error("A schedule needs a due time");
    if (input.everySeconds !== undefined && (!Number.isInteger(input.everySeconds) || input.everySeconds < MIN_REPEAT_SECONDS)) throw new Error(`everySeconds must be an integer of at least ${MIN_REPEAT_SECONDS}`);
    // Deprecated and ignored: every wake-up sees the agent's history.
    if (input.history !== undefined && !["full", "none"].includes(input.history)) throw new Error('history is "full" or "none" (deprecated: ignored, every wake-up sees the agent\'s history)');
    const { history, ...rest } = input;
    if (history === "none") historyNoneIgnored(input.agent, input.tenant, "schedule");
    const created: Schedule = { id: randomUUID(), sessionMode: "continue", ...rest, dueAt: Math.round(input.dueAt), createdAt: Date.now() };
    await underClaim(this.db, claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`schedules:${input.agent}`]);
      // A wake-up would start a turn its parent did not send: a sub-agent the runtime made has none (its builtin's either).
      if ((await sql.query("select 1 from agents where id = $1 and header->'parent' is not null", [input.agent])).rowCount) throw viaParent(input.agent);
      if ((await sql.query("select count(*) as count from schedules where agent = $1", [input.agent])).rows[0].count >= 100) throw new Error("An agent can have at most 100 schedules");
      await sql.query("insert into schedules (id, agent, tenant, text, code, due_at, every_seconds, created_at, calendar, email, cron, session_mode, spend_limit, mounts) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        [created.id, created.agent, created.tenant, created.text ?? null, created.code ?? null, created.dueAt, created.everySeconds ?? null, created.createdAt, created.calendar ?? null, created.email ?? null, created.cron ?? null, created.sessionMode ?? "continue", created.spendLimit ?? null, created.mounts ?? null]);
    });
    return created;
  }

  /**
   * The agent's wake-ups. A one-off one being delivered (claimed by the node delivering it) has left: the run it starts, and
   * anyone asking meanwhile, never see it; it is deleted once delivered, or listed again if its delivery failed.
   */
  async list(agent: string): Promise<Schedule[]> {
    return (await this.db.query(`select ${COLUMNS} from schedules where agent = $1 and monitor is null
      and not (every_seconds is null and calendar is null and cron is null and claimed_by is not null and claimed_until > now()) order by due_at, id`, [agent])).rows.map(schedule);
  }

  async remove(agent: string, id: string, claim?: Claim) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return false;
    return !!(await underClaim(this.db, claim, sql => sql.query("delete from schedules where agent = $1 and id = $2", [agent, id]))).rowCount;
  }

  async runNow(agent: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Unknown schedule");
    const row = (await this.db.query(`select ${COLUMNS} from schedules where agent=$1 and id=$2 and monitor is null`, [agent,id])).rows[0];
    if (!row) throw new HttpError(404, 'Unknown schedule');
    return this.dispatch(schedule(row), `schedule-run-${randomUUID()}`);
  }

  private async dispatch(due: Schedule, id: string) {
    const result = await this.deliver(due, id);
    const agent = result && typeof result === "object" && "agent" in result && typeof result.agent === "string" ? result.agent : due.agent;
    if (due.email) await this.db.query("insert into schedule_deliveries (id,tenant,agent,schedule,email,created_at,next_at) values ($1,$2,$3,$4,$5,$6,$6) on conflict do nothing", [id,due.tenant,agent,due.id,due.email,Date.now()]);
    return result;
  }

  /** Deliver every due wake-up this node claims. */
  async scan(now = Date.now()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (let batch; (batch = await this.claim(now)).length;) {
        for (const due of batch) await this.fire(due);
        if (batch.length < CLAIM_BATCH) break;
      }
      await this.also?.(now);
    } finally { this.scanning = false; }
  }

  private async claim(now: number): Promise<(Schedule & { claim: string; attempts: number })[]> {
    const claim = `${this.node} ${randomUUID()}`;
    const { rows } = await this.db.query(`
      update schedules set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond'
      where id in (
        select id from schedules where due_at <= $1 and (claimed_until is null or claimed_until <= now())
        order by due_at limit ${CLAIM_BATCH} for update skip locked)
      returning ${COLUMNS}, attempts`, [now, claim, CLAIM_TIMEOUT_MS]);
    return rows.map(row => {
      // Stored by an earlier release: ignored, and logged to find the schedules still carrying it.
      if (row.history === "none") historyNoneIgnored(row.agent, row.tenant, "schedule");
      return { ...schedule(row), claim, attempts: row.attempts };
    });
  }


  /**
   * Monitors. A monitor is a schedule row with `monitor` set: each occurrence sends its check as an `execute` request
   * (`monitor-check-<schedule>-<due>`), whose end `settleMonitor` reads. An occurrence is skipped, never queued, while
   * the last check is still in flight, the monitor is paused, or a failed check's backoff runs; a check that cannot be
   * sent is not retried (the next occurrence is the retry), so nothing here can wake an agent faster than its interval.
   */
  async startMonitor(agent: string, tenant: string, raw: unknown, claim?: Claim): Promise<Schedule> {
    let input;
    try { input = monitorInput(raw); } catch (error) { throw new HttpError(400, (error as Error).message); }
    const now = Date.now();
    const created: Schedule = { id: randomUUID(), agent, tenant, code: input.code, dueAt: now, everySeconds: input.everySeconds, sessionMode: "continue", createdAt: now, monitor: newMonitor(input, now) };
    await underClaim(this.db, claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`schedules:${agent}`]);
      if ((await sql.query("select 1 from agents where id = $1 and header->'parent' is not null", [agent])).rowCount) throw viaParent(agent);
      await sql.query("delete from schedules where agent = $1 and monitor->>'name' = $2", [agent, input.name]);
      if ((await sql.query("select count(*) as count from schedules where agent = $1 and monitor is not null and monitor->>'ended' is null", [agent])).rows[0].count >= MONITOR_LIMITS.perAgent) throw new HttpError(400, MONITOR_CAP_ERROR);
      await sql.query("insert into schedules (id, agent, tenant, code, due_at, every_seconds, created_at, session_mode, monitor) values ($1, $2, $3, $4, $5, $6, $7, 'continue', $8)",
        [created.id, agent, tenant, created.code, created.dueAt, created.everySeconds, created.createdAt, JSON.stringify(created.monitor)]);
    });
    return created;
  }
  async monitors(agent: string): Promise<Schedule[]> {
    return (await this.db.query(`select ${COLUMNS} from schedules where agent = $1 and monitor is not null and monitor->>'ended' is null order by created_at, id`, [agent])).rows.map(schedule);
  }
  /** One of the agent's monitors, by name or id. */
  async monitor(agent: string, key: string): Promise<Schedule | undefined> {
    return (await this.monitors(agent)).find(entry => entry.monitor!.name === key || entry.id === key);
  }
  async stopMonitor(agent: string, key: string, claim?: Claim) {
    return !!(await underClaim(this.db, claim, sql => sql.query("delete from schedules where agent = $1 and monitor is not null and (monitor->>'name' = $2 or id::text = $2)", [agent, key]))).rowCount;
  }

  /** Change a monitor under its row's lock; `change` returning undefined leaves it. Returns the row after. */
  private async changeMonitor(id: string, change: (monitor: Monitor, row: Schedule) => Monitor | undefined): Promise<Schedule | undefined> {
    return transaction(this.db, async sql => {
      const row = (await sql.query(`select ${COLUMNS} from schedules where id = $1 and monitor is not null for update`, [id])).rows[0];
      if (!row) return undefined;
      const found = schedule(row), next = change(found.monitor!, found);
      if (!next) return found;
      await sql.query("update schedules set monitor = $2 where id = $1", [id, JSON.stringify(next)]);
      return { ...found, monitor: next };
    });
  }

  /** Send the messages a monitor owes its agent; one the agent refuses for good, or five times, is dropped. An ended monitor that owes none goes. */
  private async flush(row: Schedule | undefined): Promise<Schedule | undefined> {
    if (!row?.monitor?.outbox?.length || !this.wake) return this.ended(row);
    const done = new Set<string>(), failed = new Set<string>();
    let gone = false;
    for (const wake of row.monitor.outbox) {
      try {
        await this.wake(row.agent, row.tenant, { id: wake.id, method: "prompt", params: { text: wake.text, allowDisconnected: true, ...(wake.budget ? { spendLimit: wake.budget } : {}) } });
        done.add(wake.id);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) { gone = true; break; }
        console.error(JSON.stringify({ type: "monitor_wake_failed", schedule: row.id, agent: row.agent, tenant: row.tenant, status, error: error instanceof Error ? error.message : String(error) }));
        if (!wakeRetryable(status) || (wake.attempts ?? 0) + 1 >= MONITOR_LIMITS.wakeAttempts) done.add(wake.id); else failed.add(wake.id);
      }
    }
    if (gone) { await this.db.query("delete from schedules where id = $1", [row.id]); return undefined; }
    return this.ended(await this.changeMonitor(row.id, monitor => ({ ...monitor, outbox: (monitor.outbox ?? []).filter(wake => !done.has(wake.id)).map((wake): MonitorWake => failed.has(wake.id) ? { ...wake, attempts: (wake.attempts ?? 0) + 1 } : wake) })));
  }
  private async ended(row: Schedule | undefined) {
    if (!row?.monitor?.ended || row.monitor.outbox?.length) return row;
    await this.db.query("delete from schedules where id = $1 and monitor->>'ended' is not null", [row.id]);
    return undefined;
  }

  /** A check's request ended (the sessions' `requestEnded`): settle it, and send what it owes the agent. */
  async settleMonitor(record: { id: string; state?: string; outcome?: unknown }) {
    const request = checkRequest(record.id);
    if (!request || record.state !== "completed") return;
    const result = checkResult(record as Parameters<typeof checkResult>[0]);
    let settled = false;
    const row = await this.changeMonitor(request.schedule, (monitor, found) => {
      const next = settleCheck(found.id, found.everySeconds ?? MONITOR_LIMITS.defaultSeconds, monitor, request.key, result);
      settled = !!next;
      return next;
    });
    if (settled) await this.flush(row);
  }

  /** A monitor's due occurrence, claimed: send its check, or skip it; then move to the next occurrence. */
  private async check(due: Schedule, claim: string) {
    const now = Date.now();
    const row = await this.flush(due);
    const action = row ? beforeCheck(row.monitor!, now) : "remove";
    if (!row || action === "expire" || action === "remove") {
      if (row) await this.db.query("delete from schedules where id = $1 and claimed_by = $2", [due.id, claim]);
      return;
    }
    if (action === "run") {
      const pending = (await this.db.query("update schedules set monitor = jsonb_set(monitor, '{pending}', $3::jsonb) where id = $1 and claimed_by = $2", [due.id, claim, JSON.stringify({ key: due.dueAt, at: now })])).rowCount;
      if (pending) try { await this.deliver(row, checkRequestId(due.id, due.dueAt)); }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) { await this.db.query("delete from schedules where id = $1 and claimed_by = $2", [due.id, claim]); return; }
        console.error(JSON.stringify({ type: "monitor_check_not_sent", schedule: due.id, agent: due.agent, tenant: due.tenant, status, error: error instanceof Error ? error.message : String(error) }));
        // Not sent: nothing is in flight, and the next occurrence tries again.
        await this.db.query("update schedules set monitor = monitor - 'pending' where id = $1 and monitor->'pending'->>'key' = $2", [due.id, String(due.dueAt)]);
      }
    }
    await this.db.query("update schedules set due_at = $3, claimed_by = null, claimed_until = null, attempts = 0 where id = $1 and due_at = $2 and claimed_by = $4", [due.id, due.dueAt, nextOccurrence(due), claim]);
  }

  /** Deliver a claimed wake-up, then move it to its next occurrence or drop it. Only the claim holder advances it. */
  private async fire({ claim, attempts, ...due }: Schedule & { claim: string; attempts: number }) {
    if (due.monitor) return this.check(due, claim);
    try {
      const id = `schedule-${due.id}-${due.dueAt}`;
      await this.dispatch(due, id);
    }
    catch (error) {
      // The agent was deleted or expired: drop its schedule.
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) {
        await this.db.query("delete from schedules where id = $1 and due_at = $2 and claimed_by = $3", [due.id, due.dueAt, claim]);
        return;
      }
      await this.failed(due, claim, attempts + 1, status, error);
      return;
    }
    if (due.everySeconds || due.calendar || due.cron) {
      await this.db.query(`update schedules set due_at = $3, claimed_by = null, claimed_until = null, attempts = 0, failures = 0, last_error = null, last_error_at = null
        where id = $1 and due_at = $2 and claimed_by = $4`, [due.id, due.dueAt, nextOccurrence(due), claim]);
    } else {
      await this.db.query("delete from schedules where id = $1 and due_at = $2 and claimed_by = $3", [due.id, due.dueAt, claim]);
    }
  }

  /**
   * A delivery failed (its `attempt`th of this occurrence): retry it after the next delay, with the same request id, so
   * one that reached the agent after all does not run twice; or give the occurrence up, moving a repeating schedule on.
   * Until the retry its claim's expiry holds it, the holder cleared so that it is listed meanwhile.
   */
  private async failed(due: Schedule, claim: string, attempt: number, status: number | undefined, error: unknown) {
    const now = Date.now();
    const message = `${status !== undefined ? `HTTP ${status}: ` : ""}${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
    const delay = retryable(status) ? RETRY_DELAYS_MS[attempt - 1] : undefined;
    const next = due.everySeconds || due.calendar || due.cron ? nextOccurrence(due, now) : undefined;
    const retry = delay !== undefined && (next === undefined || now + delay < next);
    console.error(JSON.stringify({ type: "schedule_delivery_failed", schedule: due.id, agent: due.agent, tenant: due.tenant, status, attempt, error: message, ...(retry ? { retryInMs: delay } : { gaveUp: true }) }));
    if (retry) {
      await this.db.query(`update schedules set attempts = $4, last_error = $5, last_error_at = $6, claimed_by = null, claimed_until = now() + $7 * interval '1 millisecond'
        where id = $1 and due_at = $2 and claimed_by = $3`, [due.id, due.dueAt, claim, attempt, message, now, delay]);
    } else if (next !== undefined) {
      await this.db.query(`update schedules set due_at = $4, attempts = 0, failures = failures + 1, last_error = $5, last_error_at = $6, claimed_by = null, claimed_until = null
        where id = $1 and due_at = $2 and claimed_by = $3`, [due.id, due.dueAt, claim, next, message, now]);
    } else {
      await this.db.query("delete from schedules where id = $1 and due_at = $2 and claimed_by = $3", [due.id, due.dueAt, claim]);
    }
  }
}

/** A repeating schedule's next occurrence after now, skipping any missed while nothing was running. */
function nextOccurrence(due: { dueAt: number; everySeconds?: number; calendar?: Calendar; cron?: Cron }, now = Date.now()) {
  if (due.cron) return nextCron(due.cron, Math.max(now, due.dueAt));
  if (due.calendar) return nextCalendar(due.calendar, Math.max(now, due.dueAt));
  const step = due.everySeconds! * 1000;
  return due.dueAt + Math.max(1, Math.ceil((now - due.dueAt + 1) / step)) * step;
}

export function validateScheduleMode(input: {code?: unknown; spendLimit?: unknown; sessionMode?: string; everySeconds?: number; cron?: Cron}) {
  if (input.code !== undefined && input.spendLimit !== undefined) throw new Error('Code schedules do not support spendLimit');
  if (input.sessionMode === 'fresh' && (input.everySeconds !== undefined && input.everySeconds < 300 || input.cron && !freshCronAllowed(input.cron)))
    throw new Error('Fresh schedules must be at least five minutes apart');
}

/** Parse `{ text | code, history?, at? (ISO time or ms), inSeconds?, everySeconds? }` into a due time. */
export function scheduleInput(body: any, now = Date.now()) {
  if (!body || typeof body !== "object") throw new Error("Send { text | code, history?, at | inSeconds, everySeconds? }");
  if (body.sessionMode !== undefined && !['continue','fresh'].includes(body.sessionMode)) throw new Error('sessionMode must be continue or fresh');
  if (body.spendLimit !== undefined && (!body.spendLimit || typeof body.spendLimit.usd !== 'number' || !Number.isFinite(body.spendLimit.usd) || body.spendLimit.usd < 0 || body.spendLimit.usd > 1000000)) throw new Error('spendLimit must be {usd} from 0 to 1000000');
  const mounts = body.mounts === undefined ? undefined : z.array(z.union([z.strictObject({volumeId:z.string(),path:z.string(),mode:z.enum(['ro','rw']),subpath:z.string().optional(),notify:z.boolean().optional()}),z.strictObject({workspace:z.boolean(),path:z.string().optional()})])).max(16).parse(body.mounts);
  if (mounts && body.sessionMode !== 'fresh') throw new Error('Schedule mounts require fresh mode');
  const cron = body.cron === undefined ? undefined : cronInput(body.cron);
  if (cron && [body.calendar, body.at, body.inSeconds, body.everySeconds].some(value => value !== undefined)) throw new Error('cron cannot be combined with other timing fields');
  validateScheduleMode({...body,cron});
  const calendar = body.calendar === undefined ? undefined : calendarInput(body.calendar);
  if (calendar && [body.at, body.inSeconds, body.everySeconds].some(value => value !== undefined)) throw new Error("calendar cannot be combined with at, inSeconds or everySeconds");
  const email = body.email === undefined ? undefined : scheduleEmail(body.email);
  const at = body.at === undefined ? undefined : typeof body.at === "number" ? body.at : Date.parse(body.at);
  const dueAt = cron ? nextCron(cron, now) : calendar ? nextCalendar(calendar, now) : at ?? (body.inSeconds !== undefined ? now + Number(body.inSeconds) * 1000 : body.everySeconds !== undefined ? now + Number(body.everySeconds) * 1000 : NaN);
  if (!Number.isFinite(dueAt)) throw new Error("Give a due time: at (ISO time) or inSeconds");
  if (!cron && dueAt > now + 366 * 86_400_000) throw new Error("Schedules can be at most a year ahead");
  return { ...(mounts ? {mounts} : {}), ...(cron ? { cron } : {}), ...(body.sessionMode !== undefined ? {sessionMode: body.sessionMode as "continue" | "fresh"} : {}), ...(body.spendLimit !== undefined ? {spendLimit: body.spendLimit as {usd:number}} : {}), ...(calendar ? { calendar } : {}), ...(email ? { email } : {}), ...(body.text !== undefined ? { text: body.text } : {}), ...(body.code !== undefined ? { code: body.code } : {}), ...(body.history !== undefined ? { history: body.history } : {}), dueAt: Math.max(dueAt, now), ...(body.everySeconds !== undefined ? { everySeconds: Number(body.everySeconds) } : {}) };
}
