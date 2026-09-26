import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
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
 * moves it on, even after its node restarted under the same name. An agent's own
 * routes, served by its owner, also pass the owner's claim: a node that lost the
 * agent then changes none of its schedules.
 */
/** A wake-up either prompts the agent (`text`) or runs sandboxed code with its tools (`code`). */
export interface Schedule {
  id: string; agent: string; tenant: string; text?: string; code?: string;
  dueAt: number; everySeconds?: number; createdAt: number;
}
export type Deliver = (schedule: Schedule, requestId: string) => Promise<void>;

/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_TIMEOUT_MS = 60_000;
const CLAIM_BATCH = 100;
export const MIN_REPEAT_SECONDS = 60;
const COLUMNS = "id, agent, tenant, text, code, due_at, every_seconds, created_at";
const schedule = (row: any): Schedule => ({
  id: row.id, agent: row.agent, tenant: row.tenant, ...(row.text !== null ? { text: row.text } : {}), ...(row.code !== null ? { code: row.code } : {}),
  dueAt: row.due_at, ...(row.every_seconds !== null ? { everySeconds: row.every_seconds } : {}), createdAt: row.created_at,
});

export class Scheduler {
  readonly db: Db;
  readonly node: string;
  private readonly deliver: Deliver;
  /** Other due work the scan takes care of: human input past its expiry. */
  private readonly also?: (now: number) => Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(options: { db: Db; node: string; deliver: Deliver; also?: (now: number) => Promise<unknown> }) {
    this.db = options.db;
    this.node = options.node;
    this.deliver = options.deliver;
    this.also = options.also;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "scheduler_scan_failed", error: String(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async create(input: { agent: string; tenant: string; text?: string; code?: string; dueAt: number; everySeconds?: number }, claim?: Claim): Promise<Schedule> {
    const content = input.text ?? input.code;
    if ((input.text === undefined) === (input.code === undefined) || typeof content !== "string" || !content.trim() || content.length > 32_000) throw new Error("Give exactly one of text or code (1–32000 characters)");
    if (!Number.isFinite(input.dueAt)) throw new Error("A schedule needs a due time");
    if (input.everySeconds !== undefined && (!Number.isInteger(input.everySeconds) || input.everySeconds < MIN_REPEAT_SECONDS)) throw new Error(`everySeconds must be an integer of at least ${MIN_REPEAT_SECONDS}`);
    const created: Schedule = { id: randomUUID(), ...input, dueAt: Math.round(input.dueAt), createdAt: Date.now() };
    await underClaim(this.db, claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`schedules:${input.agent}`]);
      if ((await sql.query("select count(*) as count from schedules where agent = $1", [input.agent])).rows[0].count >= 100) throw new Error("An agent can have at most 100 schedules");
      await sql.query(`insert into schedules (${COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [created.id, created.agent, created.tenant, created.text ?? null, created.code ?? null, created.dueAt, created.everySeconds ?? null, created.createdAt]);
    });
    return created;
  }

  async list(agent: string): Promise<Schedule[]> {
    return (await this.db.query(`select ${COLUMNS} from schedules where agent = $1 order by due_at, id`, [agent])).rows.map(schedule);
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

  private async claim(now: number): Promise<(Schedule & { claim: string })[]> {
    const claim = `${this.node} ${randomUUID()}`;
    const { rows } = await this.db.query(`
      update schedules set claimed_by = $2, claimed_until = now() + $3 * interval '1 millisecond'
      where id in (
        select id from schedules where due_at <= $1 and (claimed_until is null or claimed_until <= now())
        order by due_at limit ${CLAIM_BATCH} for update skip locked)
      returning ${COLUMNS}`, [now, claim, CLAIM_TIMEOUT_MS]);
    return rows.map(row => ({ ...schedule(row), claim }));
  }

  /** Deliver a claimed wake-up, then move it to its next occurrence or drop it. Only the claim holder advances it. */
  private async fire({ claim, ...due }: Schedule & { claim: string }) {
    try { await this.deliver(due, `schedule-${due.id}-${due.dueAt}`); }
    catch (error) {
      // The agent was deleted or expired: drop its schedule. Anything else retries after the claim times out.
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 410) throw error;
      await this.db.query("delete from schedules where id = $1 and due_at = $2 and claimed_by = $3", [due.id, due.dueAt, claim]);
      return;
    }
    if (due.everySeconds) {
      // Next occurrence after now, skipping any missed while nothing was running.
      const step = due.everySeconds * 1000;
      const next = due.dueAt + Math.max(1, Math.ceil((Date.now() - due.dueAt + 1) / step)) * step;
      await this.db.query("update schedules set due_at = $3, claimed_by = null, claimed_until = null where id = $1 and due_at = $2 and claimed_by = $4", [due.id, due.dueAt, next, claim]);
    } else {
      await this.db.query("delete from schedules where id = $1 and due_at = $2 and claimed_by = $3", [due.id, due.dueAt, claim]);
    }
  }
}

/** Parse `{ text | code, at? (ISO time or ms), inSeconds?, everySeconds? }` into a due time. */
export function scheduleInput(body: any, now = Date.now()) {
  if (!body || typeof body !== "object") throw new Error("Send { text | code, at | inSeconds, everySeconds? }");
  const at = body.at === undefined ? undefined : typeof body.at === "number" ? body.at : Date.parse(body.at);
  const dueAt = at ?? (body.inSeconds !== undefined ? now + Number(body.inSeconds) * 1000 : body.everySeconds !== undefined ? now + Number(body.everySeconds) * 1000 : NaN);
  if (!Number.isFinite(dueAt)) throw new Error("Give a due time: at (ISO time) or inSeconds");
  if (dueAt > now + 366 * 86_400_000) throw new Error("Schedules can be at most a year ahead");
  return { ...(body.text !== undefined ? { text: body.text } : {}), ...(body.code !== undefined ? { code: body.code } : {}), dueAt: Math.max(dueAt, now), ...(body.everySeconds !== undefined ? { everySeconds: Number(body.everySeconds) } : {}) };
}
