import { calendarInput, nextCalendar, type Calendar } from "./calendar.ts";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { historyNoneIgnored } from "./history-none.ts";
import { HttpError } from "./http.ts";
import { underClaim, type Claim } from "./ownership.ts";

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
  dueAt: number; everySeconds?: number; calendar?: Calendar; email?: ScheduleEmail; createdAt: number;
  /** Occurrences in a row whose delivery was given up, and why the latest attempt failed: until a delivery succeeds. */
  failures?: number; lastError?: string; lastErrorAt?: number;
}
export interface ScheduleEmail { to: string; subject: string; format?: "text" | "markdown" | "html" }
export function scheduleEmail(value: any): ScheduleEmail {
  if (!value || !z.email().safeParse(value.to).success || typeof value.subject !== "string" || !value.subject.trim() || value.subject.length > 200 || /[\r\n]/.test(value.subject)) throw new Error("email needs a valid to address and a subject (1–200 characters, one line)");
  if (value.format !== undefined && !["text", "markdown", "html"].includes(value.format)) throw new Error("email format must be text, markdown, or html");
  return { to: value.to, subject: value.subject.trim(), ...(value.format !== undefined ? { format: value.format } : {}) };
}
export type Deliver = (schedule: Schedule, requestId: string) => Promise<void>;

/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_TIMEOUT_MS = 60_000;
const CLAIM_BATCH = 100;
/** How long after each failed delivery of an occurrence it is tried again; past the last, it is given up. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Failures a retry may fix: no status (the network, a crash), a timeout, a conflict, a rate limit, or a server error. */
const retryable = (status: number | undefined) => status === undefined || status >= 500 || [408, 409, 425, 429].includes(status);
export const MIN_REPEAT_SECONDS = 60;
const COLUMNS = "id, agent, tenant, text, code, history, due_at, every_seconds, calendar, email, created_at, failures, last_error, last_error_at";
const schedule = (row: any): Schedule => ({
  id: row.id, agent: row.agent, tenant: row.tenant, ...(row.calendar ? { calendar: row.calendar } : {}), ...(row.email ? { email: row.email } : {}), ...(row.text !== null ? { text: row.text } : {}), ...(row.code !== null ? { code: row.code } : {}),
  dueAt: row.due_at, ...(row.every_seconds !== null ? { everySeconds: row.every_seconds } : {}), createdAt: row.created_at,
  ...(row.failures ? { failures: row.failures } : {}), ...(row.last_error !== null ? { lastError: row.last_error, lastErrorAt: Number(row.last_error_at) } : {}),
});

export class Scheduler {
  readonly db: Db;
  readonly node: string;
  private readonly deliver: Deliver;
  private readonly emailEnabled: boolean;
  private readonly canEmail?: (tenant: string, to: string) => Promise<boolean>;
  /** Other due work the scan takes care of: human input past its expiry. */
  private readonly also?: (now: number) => Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(options: { db: Db; node: string; deliver: Deliver; emailEnabled?: boolean; canEmail?: (tenant: string, to: string) => Promise<boolean>; also?: (now: number) => Promise<unknown> }) {
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

  async create(input: { agent: string; tenant: string; text?: string; code?: string; history?: string; dueAt: number; everySeconds?: number; calendar?: Calendar; email?: ScheduleEmail }, claim?: Claim): Promise<Schedule> {
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
    const created: Schedule = { id: randomUUID(), ...rest, dueAt: Math.round(input.dueAt), createdAt: Date.now() };
    await underClaim(this.db, claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`schedules:${input.agent}`]);
      if ((await sql.query("select count(*) as count from schedules where agent = $1", [input.agent])).rows[0].count >= 100) throw new Error("An agent can have at most 100 schedules");
      await sql.query("insert into schedules (id, agent, tenant, text, code, due_at, every_seconds, created_at, calendar, email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [created.id, created.agent, created.tenant, created.text ?? null, created.code ?? null, created.dueAt, created.everySeconds ?? null, created.createdAt, created.calendar ?? null, created.email ?? null]);
    });
    return created;
  }

  /**
   * The agent's wake-ups. A one-off one being delivered (claimed by the node delivering it) has left: the run it starts, and
   * anyone asking meanwhile, never see it; it is deleted once delivered, or listed again if its delivery failed.
   */
  async list(agent: string): Promise<Schedule[]> {
    return (await this.db.query(`select ${COLUMNS} from schedules where agent = $1
      and not (every_seconds is null and calendar is null and claimed_by is not null and claimed_until > now()) order by due_at, id`, [agent])).rows.map(schedule);
  }

  async remove(agent: string, id: string, claim?: Claim) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return false;
    return !!(await underClaim(this.db, claim, sql => sql.query("delete from schedules where agent = $1 and id = $2", [agent, id]))).rowCount;
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

  /** Deliver a claimed wake-up, then move it to its next occurrence or drop it. Only the claim holder advances it. */
  private async fire({ claim, attempts, ...due }: Schedule & { claim: string; attempts: number }) {
    try {
      const id = `schedule-${due.id}-${due.dueAt}`;
      if (due.email) await this.db.query("insert into schedule_deliveries (id,tenant,agent,schedule,email,created_at,next_at) values ($1,$2,$3,$4,$5,$6,$6) on conflict do nothing", [id,due.tenant,due.agent,due.id,due.email,Date.now()]);
      await this.deliver(due, id);
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
    if (due.everySeconds || due.calendar) {
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
    const next = due.everySeconds || due.calendar ? nextOccurrence(due, now) : undefined;
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
function nextOccurrence(due: { dueAt: number; everySeconds?: number; calendar?: Calendar }, now = Date.now()) {
  if (due.calendar) return nextCalendar(due.calendar, Math.max(now, due.dueAt));
  const step = due.everySeconds! * 1000;
  return due.dueAt + Math.max(1, Math.ceil((now - due.dueAt + 1) / step)) * step;
}

/** Parse `{ text | code, history?, at? (ISO time or ms), inSeconds?, everySeconds? }` into a due time. */
export function scheduleInput(body: any, now = Date.now()) {
  if (!body || typeof body !== "object") throw new Error("Send { text | code, history?, at | inSeconds, everySeconds? }");
  const calendar = body.calendar === undefined ? undefined : calendarInput(body.calendar);
  if (calendar && [body.at, body.inSeconds, body.everySeconds].some(value => value !== undefined)) throw new Error("calendar cannot be combined with at, inSeconds or everySeconds");
  const email = body.email === undefined ? undefined : scheduleEmail(body.email);
  const at = body.at === undefined ? undefined : typeof body.at === "number" ? body.at : Date.parse(body.at);
  const dueAt = calendar ? nextCalendar(calendar, now) : at ?? (body.inSeconds !== undefined ? now + Number(body.inSeconds) * 1000 : body.everySeconds !== undefined ? now + Number(body.everySeconds) * 1000 : NaN);
  if (!Number.isFinite(dueAt)) throw new Error("Give a due time: at (ISO time) or inSeconds");
  if (dueAt > now + 366 * 86_400_000) throw new Error("Schedules can be at most a year ahead");
  return { ...(calendar ? { calendar } : {}), ...(email ? { email } : {}), ...(body.text !== undefined ? { text: body.text } : {}), ...(body.code !== undefined ? { code: body.code } : {}), ...(body.history !== undefined ? { history: body.history } : {}), dueAt: Math.max(dueAt, now), ...(body.everySeconds !== undefined ? { everySeconds: Number(body.everySeconds) } : {}) };
}
