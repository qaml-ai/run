import type { AgentInvocation } from "./agent-invocation.ts";
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import {
  beforeCheck, checkCode, checkKey, checkRequest, checkRequestId, checkResult, monitorInput, monitorToolView, monitorView, newMonitor, settleCheck, wakeRetryable,
  MONITOR_CAP_ERROR, MONITOR_LIMITS, MONITOR_TOOLS, type MonitorWake,
} from '../../../shared/monitors.ts';
import { HttpError } from './errors.ts';
import { viaParent } from './multi-agent-policy.ts';
import { childParent } from './child-parent.ts';
import { nextOccurrence } from './schedule-policy.ts';
import { failure } from './observability.ts';
import type { StoredSchedule as Schedule } from './schedules.ts';
import type { AgentRuntime } from './agent-runtime.ts';
import { reqKey } from './agent-types.ts';

/**
 * Monitors on Workers (shared/monitors.ts): a monitor is one of the agent's schedules (`schedule:<id>` in its storage)
 * with `monitor` set. The agent's alarm sends each due check as an `execute` request of its own; the request's end
 * settles it in the transaction that publishes its response. Wake safety: the alarm is armed for a monitor's due time
 * (never under its interval, 60 s at least), an occurrence is skipped while the last check is in flight, a check that
 * cannot be sent is left to the next occurrence, and a message the agent did not take is tried again a minute later,
 * five times at most.
 */
export type MonitorToolsHost = { start(input: unknown): Promise<Schedule>; list(): Promise<Schedule[]>; stop(name: string): Promise<boolean> };

const key = (id: string) => `schedule:${id}`;
/**
 * Check request records must not pile up in the agent's storage (every wake lists its requests). A settled check's
 * record goes at the monitor's next occurrence; one of a monitor that is removed is marked here and goes a minute on.
 */
const GC = 'monitor-gc:';
type Mark = { first: number; next: number };
async function forget(storage: { put(key: string, value: unknown): Promise<unknown> }, schedule: Schedule) {
  const now = Date.now();
  for (const at of [schedule.monitor?.settled, schedule.monitor?.pending?.key]) if (at !== undefined) await storage.put(`${GC}${checkRequestId(schedule.id, at)}`, { first: now, next: now + 60_000 } satisfies Mark);
}
export async function collectChecks(runtime: AgentRuntime, now = Date.now()) {
  for (const [name, mark] of await runtime.ctx.storage.list<Mark>({ prefix: GC, limit: 100 })) {
    if (now < mark.next) continue;
    const record = await runtime.ctx.storage.get<{ state?: string }>(reqKey(name.slice(GC.length)));
    // A check still queued or running keeps its record: it is deleted only once it has settled. Looked at again a
    // minute on, and every fifteen minutes once it has waited an hour, so the wait never spins the alarm.
    if (record && record.state !== 'completed') await runtime.ctx.storage.put(name, { first: mark.first, next: now + (now - mark.first < 3_600_000 ? 60_000 : 900_000) } satisfies Mark);
    else await runtime.ctx.storage.delete([reqKey(name.slice(GC.length)), name]);
  }
}
export async function checkGcDeadline(runtime: AgentRuntime) {
  const marks = [...(await runtime.ctx.storage.list<Mark>({ prefix: GC, limit: 100 })).values()];
  return marks.length ? Math.max(Date.now() + 1000, Math.min(...marks.map(mark => mark.next))) : Infinity;
}
export async function monitorsOf(runtime: AgentRuntime): Promise<Schedule[]> {
  return [...(await runtime.ctx.storage.list<Schedule>({ prefix: 'schedule:', limit: 100 })).values()]
    .filter(schedule => schedule.monitor && !schedule.monitor.ended).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export async function startMonitor(runtime: AgentRuntime, raw: unknown): Promise<Schedule> {
  let input;
  try { input = monitorInput(raw); } catch (error) { throw new HttpError(400, (error as Error).message); }
  const conf = await runtime.config();
  // A fire would start a turn its parent did not send: a sub-agent has no monitors, as it has no schedules.
  if (conf.config.type === 'subagent' && await childParent(runtime.env, conf.tenantId, conf.id)) throw viaParent(conf.id);
  const now = Date.now();
  const schedule: Schedule = { id: crypto.randomUUID(), agent: conf.id, tenant: conf.tenantId, code: input.code, dueAt: now, everySeconds: input.everySeconds, sessionMode: 'continue', createdAt: now, monitor: newMonitor(input, now) };
  await runtime.ctx.storage.transaction(async tx => {
    const all = [...(await tx.list<Schedule>({ prefix: 'schedule:', limit: 100 })).values()];
    const replaced = all.filter(entry => entry.monitor?.name === input.name);
    if (all.filter(entry => entry.monitor && !entry.monitor.ended).length - replaced.filter(entry => !entry.monitor!.ended).length >= MONITOR_LIMITS.perAgent) throw new HttpError(400, MONITOR_CAP_ERROR);
    if (all.length - replaced.length >= 100) throw new HttpError(400, 'At most 100 schedules per agent');
    for (const entry of replaced) { await forget(tx, entry); await tx.delete(key(entry.id)); }
    await tx.put(key(schedule.id), schedule);
  });
  await runtime.arm();
  return schedule;
}
export async function stopMonitor(runtime: AgentRuntime, name: string) {
  const found = (await monitorsOf(runtime)).filter(schedule => schedule.monitor!.name === name || schedule.id === name);
  for (const schedule of found) { await forget(runtime.ctx.storage, schedule); await runtime.ctx.storage.delete(key(schedule.id)); }
  if (found.length) await runtime.arm();
  return found.length > 0;
}
export function monitorToolsHost(runtime: AgentRuntime): MonitorToolsHost {
  return { start: raw => startMonitor(runtime, raw), list: () => monitorsOf(runtime), stop: name => stopMonitor(runtime, name) };
}

/** `/monitors` routes of the agent's object (GET, POST, GET/DELETE one by id or name, GET its checks). */
export async function monitorRoutes(runtime: AgentRuntime, path: string, request: Request, body: (request: Request) => Promise<unknown>): Promise<{ value: unknown; status?: number } | undefined> {
  const match = /^\/monitors(?:\/([^/]+)(\/checks)?)?$/.exec(path);
  if (!match) return undefined;
  const [, encoded, checks] = match;
  if (!encoded) {
    if (request.method === 'GET') return { value: (await monitorsOf(runtime)).map(monitorView) };
    if (request.method === 'POST') return { value: monitorView(await startMonitor(runtime, await body(request))), status: 201 };
    throw new HttpError(404, 'Unknown monitor route');
  }
  const name = decodeURIComponent(encoded);
  const found = (await monitorsOf(runtime)).find(schedule => schedule.monitor!.name === name || schedule.id === name);
  if (!found) throw new HttpError(404, 'Unknown monitor');
  if (checks && request.method === 'GET') return { value: found.monitor!.log };
  if (!checks && request.method === 'GET') return { value: monitorView(found) };
  if (!checks && request.method === 'DELETE') { await stopMonitor(runtime, found.id); return { value: { stopped: true } }; }
  throw new HttpError(404, 'Unknown monitor route');
}

export function agentMonitorTools(builtins: string[] | undefined, host?: MonitorToolsHost): ToolRegistration[] {
  if (!builtins?.includes('monitor') || !host) return [];
  return MONITOR_TOOLS.map(definition => {
    const check = compile(definition.parameters as never);
    return defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, structuredOutputSchema: {}, replay: 'safe', execute: async (args: Record<string, unknown>) => {
      if (!(check.check as (value: unknown) => boolean)(args)) throw new HttpError(400, `Invalid ${definition.name} arguments`);
      const value = definition.name === 'monitor_start' ? monitorToolView(await host.start(args))
        : definition.name === 'monitor_list' ? { monitors: (await host.list()).map(monitorToolView) }
        : { stopped: await host.stop(String(args.name)) };
      return { output: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value as never, structuredOutput: value as never };
    } });
  });
}

/** When the alarm is next needed for monitors: a due check, or a message still owed (a minute on, never sooner). */
export function monitorDeadline(schedule: Schedule, now = Date.now()) {
  return schedule.monitor?.outbox?.length ? Math.min(schedule.dueAt, now + 60_000) : schedule.dueAt;
}

/** A check's request ended, in the transaction that publishes its response: the monitor after it. True when it owes the agent a message. */
export async function stageMonitorSettle(tx: DurableObjectTransaction, record: { id: string; state?: string; outcome?: unknown }) {
  const request = checkRequest(record.id);
  if (!request) return false;
  const schedule = await tx.get<Schedule>(key(request.schedule));
  if (!schedule?.monitor) return false;
  const next = settleCheck(schedule.id, schedule.everySeconds ?? MONITOR_LIMITS.defaultSeconds, schedule.monitor, request.key, checkResult(record as Parameters<typeof checkResult>[0]));
  if (!next) return false;
  await tx.put(key(schedule.id), { ...schedule, monitor: next });
  return !!next.outbox?.length;
}

/** Send the messages monitors owe the agent (as prompts of its own queue); an ended monitor that owes none goes. */
export async function flushMonitors(runtime: AgentRuntime, invocation: AgentInvocation) {
  for (const schedule of (await runtime.ctx.storage.list<Schedule>({ prefix: 'schedule:', limit: 100 })).values()) {
    if (!schedule.monitor) continue;
    const done = new Set<string>(), failed = new Set<string>();
    for (const wake of schedule.monitor.outbox ?? []) {
      try {
        await runtime.submit(invocation, { id: wake.id, method: 'prompt', params: { text: wake.text, allowDisconnected: true, ...(wake.budget ? { spendLimit: wake.budget } : {}) } });
        done.add(wake.id);
      } catch (error) {
        failure(runtime.env, 'monitor_wake_failed', error);
        if (!wakeRetryable((error as { status?: number }).status) || (wake.attempts ?? 0) + 1 >= MONITOR_LIMITS.wakeAttempts) done.add(wake.id); else failed.add(wake.id);
      }
    }
    await runtime.ctx.storage.transaction(async tx => {
      const current = await tx.get<Schedule>(key(schedule.id));
      if (!current?.monitor) return;
      const outbox = (current.monitor.outbox ?? []).filter(wake => !done.has(wake.id)).map((wake): MonitorWake => failed.has(wake.id) ? { ...wake, attempts: (wake.attempts ?? 0) + 1 } : wake);
      if (current.monitor.ended && !outbox.length) { await forget(tx, current); await tx.delete(key(schedule.id)); }
      else if (done.size || failed.size) await tx.put(key(schedule.id), { ...current, monitor: { ...current.monitor, outbox } });
    });
  }
}

/** A monitor's due occurrence, from the alarm: send its check or skip it, having moved to the next occurrence first. */
export async function monitorDue(runtime: AgentRuntime, invocation: AgentInvocation, schedule: Schedule, now = Date.now()) {
  const action = beforeCheck(schedule.monitor!, now);
  if (action === 'expire' || action === 'remove') { await forget(runtime.ctx.storage, schedule); await runtime.ctx.storage.delete(key(schedule.id)); return; }
  // One open request a monitor: a check still in flight is sent again under its own id, never beside a new one.
  const due = checkKey(schedule.monitor!, schedule.dueAt);
  // The last settled check's request record goes now, an interval after it ended.
  if (schedule.monitor!.settled !== undefined && schedule.monitor!.settled !== due) await runtime.ctx.storage.delete(reqKey(checkRequestId(schedule.id, schedule.monitor!.settled)));
  // Moved on before anything is sent: whatever happens next, this occurrence is not delivered twice.
  const next: Schedule = { ...schedule, dueAt: nextOccurrence(schedule), monitor: action === 'run' ? { ...schedule.monitor!, pending: { key: due, at: now } } : schedule.monitor! };
  await runtime.ctx.storage.put(key(schedule.id), next);
  if (action !== 'run') return;
  try {
    const record = await runtime.submit(invocation, { id: checkRequestId(schedule.id, due), method: 'execute', params: { code: checkCode(schedule.code!, schedule.monitor!.state), timeoutMs: MONITOR_LIMITS.timeoutMs, maxOutputCharacters: 16_000, allowDisconnected: true } }) as { id?: string; state?: string } | undefined;
    // It had ended already (its settling was lost): settle it from its record.
    if (record?.id && record.state === 'completed' && await runtime.ctx.storage.transaction(tx => stageMonitorSettle(tx, record as { id: string }))) await flushMonitors(runtime, invocation);
  } catch (error) {
    failure(runtime.env, 'monitor_check_not_sent', error);
    // Refused for good (the account is out of credit, a spend limit): a failed check, which backs off and in the end
    // stops the monitor. Not sent otherwise: nothing is in flight, and the next occurrence tries again.
    const refused = !wakeRetryable((error as { status?: number }).status);
    if (refused && await runtime.ctx.storage.transaction(tx => stageMonitorSettle(tx, { id: checkRequestId(schedule.id, due), state: 'refused' }))) await flushMonitors(runtime, invocation);
    if (!refused) await runtime.ctx.storage.transaction(async tx => {
      const current = await tx.get<Schedule>(key(schedule.id));
      if (current?.monitor?.pending?.key !== due) return;
      const { pending: _pending, ...monitor } = current.monitor;
      await tx.put(key(schedule.id), { ...current, monitor });
    });
  }
}
