import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RequestMethod, RequestRecord } from "../shared/client-protocol.ts";
import { loadDecision, MAX_RESUMES } from "../src/client-sessions.ts";
import { openCalls, RERUN } from "../src/agent-host.ts";
import { interruptedTurnRepairs } from "../src/history.ts";
import { check, fc } from "./prop-helpers.ts";

/**
 * I3 (design §3): every accepted run reaches exactly one terminal outcome, which never changes; a begun turn resumes at
 * most MAX_RESUMES times; queued work is never dropped by a crash; and the transcript a lost node leaves is repaired into
 * a valid one. The load decision and the transcript repairs are the runtime's own functions; the run lifecycle around
 * them is modelled on `ClientSessions.run`/`loadOwned` (client-sessions.ts), with crashes at every step.
 */
const RUN_METHODS: RequestMethod[] = ["prompt", "execute", "continue", "resume"];
const METHODS: RequestMethod[] = [...RUN_METHODS, "configure", "status", "abort", "steer"];

// --- The load decision ----------------------------------------------------------------------------------------------

const record = fc.record({
  id: fc.constant("r"), fingerprint: fc.constant("f"), method: fc.constantFrom(...METHODS), state: fc.constant("running" as const),
  params: fc.option(fc.oneof(fc.constant({}), fc.dictionary(fc.string({ maxLength: 4 }), fc.jsonValue({ maxDepth: 1 }))), { nil: undefined }),
  began: fc.option(fc.nat(), { nil: undefined }), resumes: fc.option(fc.nat({ max: 5 }), { nil: undefined }), startedAt: fc.option(fc.nat(), { nil: undefined }),
  handedOff: fc.option(fc.record({ step: fc.constantFrom("model" as const, "tool" as const), boundaryWaitMs: fc.nat() }), { nil: undefined }),
  abortedAt: fc.option(fc.nat(), { nil: undefined }),
}, { requiredKeys: ["id", "fingerprint", "method", "state"] }) as fc.Arbitrary<RequestRecord>;

test("load decision: a stopped run ends; queued work always runs; only a begun model turn resumes, below the cap (or handed off); nothing else is resumed", async t => {
  await check(t, fc.property(record, request => {
    const decision = loadDecision(request);
    // The agent was stopped in it (abortedAt is written durably before the stop reaches the turn): it never resumes nor
    // runs, whatever else the record says; it ends aborted.
    if (request.abortedAt !== undefined) return assert.equal(decision, "aborted");
    assert.notEqual(decision, "aborted", "only a stopped run ends aborted");
    // Work that kept its params never began (or is configuration, which is idempotent): it is never dropped or failed.
    if (request.params !== undefined) return assert.equal(decision, "queued");
    const turn = ["prompt", "continue", "resume"].includes(request.method) && !!request.began;
    if (decision === "resume") {
      assert.ok(turn, "only a model turn that began resumes");
      // A hand-off at a step boundary lost nothing: it goes on whatever its count; any other resume is under the cap.
      assert.ok(request.handedOff || (request.resumes ?? 0) < MAX_RESUMES, "never past MAX_RESUMES");
    } else {
      assert.equal(decision, "uncertain");
      // Uncertain is for what began and may have had effects (or is no run), never for a resumable turn under the cap.
      assert.ok(!turn || (!request.handedOff && (request.resumes ?? 0) >= MAX_RESUMES));
    }
  }), { runs: 500 });
});

// --- The run lifecycle, with crashes ---------------------------------------------------------------------------------

/**
 * One agent's journal: records appended in memory, durable only once flushed (`AppendLog.flush`). A crash loses what
 * was not flushed. Folding keeps each request's latest record, as `ClientSessions.track` does.
 */
class Journal {
  durable: RequestRecord[] = [];
  private buffered: RequestRecord[] = [];
  append(entry: RequestRecord) { this.buffered.push(structuredClone(entry)); }
  flush() { this.durable.push(...this.buffered); this.buffered = []; }
  crash() { this.buffered = []; }
}

type Op = { t: "accept"; method: "prompt" | "execute" | "continue" | "configure" } | { t: "step" } | { t: "crash" } | { t: "flush" } | { t: "load" } | { t: "handoff" };
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("accept" as const), method: fc.constantFrom("prompt" as const, "execute" as const, "continue" as const, "configure" as const) }) },
  { weight: 6, arbitrary: fc.constant({ t: "step" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "crash" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "flush" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "load" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "handoff" as const }) },
);

/** What the world saw: effects each run had (model calls, tool calls), and the outcomes published for each. */
type Observed = { effects: Map<string, number>; begins: Map<string, number>; published: Map<string, unknown[]>; accepted: Set<string>; handoffs: Map<string, number> };

/**
 * A node serving the agent: its folded requests and its queue of runs, each run stepping through `run`'s phases:
 * begin (its record without params, `began` set, `resumes` counted when it is a resume but not a hand-off's
 * continuation; durable before any effect, except an execution's, made durable by its first tool call's
 * `beforeEffect`), an effect, and its completion (durable, then published). A node that leaves hands its model turn off
 * at a step boundary (`park`): the record marked `handedOff`, durably, and the agent given up.
 */
class Node {
  requests = new Map<string, RequestRecord>();
  running = new Map<string, RequestRecord>();
  queue: { id: string; phase: "begin" | "effect" | "complete" }[] = [];
  resuming = new Set<string>();
  private readonly journal: Journal;
  private readonly seen: Observed;
  constructor(journal: Journal, seen: Observed) { this.journal = journal; this.seen = seen; }

  private upsert(next: RequestRecord) {
    this.requests.set(next.id, next);
    if (next.state === "running") this.running.set(next.id, next); else this.running.delete(next.id);
    this.journal.append(next);
  }

  /** `loadOwned`: fold the journal, then decide each running request with the runtime's `loadDecision`. */
  load(now: number) {
    for (const entry of this.journal.durable) {
      this.requests.set(entry.id, entry);
      if (entry.state === "running") this.running.set(entry.id, entry); else this.running.delete(entry.id);
    }
    const queued: RequestRecord[] = [], resumed: RequestRecord[] = [];
    for (const request of [...this.running.values()]) {
      const decision = loadDecision(request);
      if (decision === "queued") queued.push(request);
      else if (decision === "resume") resumed.push(request);
      else this.upsert({ ...request, state: "completed", endedAt: now, outcome: { error: "The runtime restarted during this request", uncertain: true } });
    }
    this.journal.flush();
    for (const request of resumed) { this.resuming.add(request.id); this.queue.push({ id: request.id, phase: "begin" }); }
    for (const request of queued.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) this.queue.push({ id: request.id, phase: "begin" });
  }

  accept(id: string, method: RequestMethod, now: number) {
    this.upsert({ id, fingerprint: id, method, state: "running", startedAt: now, params: { text: id } });
    // A request is acknowledged (202) once its record is durable.
    this.journal.flush();
    this.seen.accepted.add(id);
    this.queue.push({ id, phase: "begin" });
  }

  /** Leave at a step boundary: a model turn between its steps is handed off, durably; the node then gives the agent up. */
  handOff(now: number) {
    const head = this.queue[0];
    const current = head && this.requests.get(head.id);
    if (!head || head.phase === "begin" || !current || !["prompt", "continue"].includes(current.method)) return false;
    const { params: _params, ...rest } = current;
    this.upsert({ ...rest, handedOff: { step: "model", boundaryWaitMs: 0 }, handoffs: [...rest.handoffs ?? [], { reason: "drain", at: now }] });
    this.journal.flush();
    this.seen.handoffs.set(current.id, (this.seen.handoffs.get(current.id) ?? 0) + 1);
    return true;
  }

  /** Advance the run at the head of the queue by one phase. */
  step(now: number) {
    const head = this.queue[0];
    if (!head) return false;
    const current = this.requests.get(head.id)!;
    if (head.phase === "begin") {
      // A run whose record is no longer running (it ended meanwhile) does nothing (`run`'s first check).
      if (current.state !== "running") { this.queue.shift(); return true; }
      if (current.method === "configure") {
        // Configuration keeps its params as it begins: the next owner replays one that was interrupted.
        this.upsert({ ...current, began: now });
      } else {
        const { params: _params, handedOff, ...rest } = current;
        const resuming = this.resuming.has(current.id);
        // A handed-off turn goes on as it was: not a resume, its time counted from its first begin.
        const continued = resuming && !!handedOff;
        this.upsert({ ...rest, began: continued && rest.began ? rest.began : now, ...(resuming && !continued ? { resumes: (rest.resumes ?? 0) + 1 } : {}) });
        // An execution's record is made durable by its first tool call (`beforeEffect`); a model run's at once.
        if (current.method !== "execute") this.journal.flush();
      }
      this.seen.begins.set(current.id, (this.seen.begins.get(current.id) ?? 0) + 1);
      head.phase = "effect";
      return true;
    }
    if (head.phase === "effect") {
      if (current.method === "execute") this.journal.flush();
      this.seen.effects.set(current.id, (this.seen.effects.get(current.id) ?? 0) + 1);
      head.phase = "complete";
      return true;
    }
    this.resuming.delete(current.id);
    const { params: _params, ...finished } = current;
    const outcome = { result: { ran: current.id, at: now } };
    this.upsert({ ...finished, state: "completed", outcome, endedAt: now });
    this.journal.flush();
    // Published only once durable.
    this.seen.published.set(current.id, [...this.seen.published.get(current.id) ?? [], outcome]);
    this.queue.shift();
    return true;
  }
}

/** Run `ops` against one agent, then let a last node finish everything without faults; return what was observed. */
function simulate(ops: Op[]) {
  const journal = new Journal();
  const seen: Observed = { effects: new Map(), begins: new Map(), published: new Map(), accepted: new Set(), handoffs: new Map() };
  let node: Node | undefined, clock = 1, ids = 0;
  const loaded = () => { if (!node) { node = new Node(journal, seen); node.load(clock++); } return node; };
  for (const next of ops) {
    if (next.t === "accept") loaded().accept(`r${ids++}`, next.method, clock++);
    else if (next.t === "step") loaded().step(clock++);
    else if (next.t === "flush") journal.flush();
    else if (next.t === "load") loaded();
    else if (next.t === "handoff") { if (loaded().handOff(clock++)) node = undefined; }
    else { journal.crash(); node = undefined; }
  }
  const last = loaded();
  for (let guard = 0; last.step(clock++); guard++) assert.ok(guard < 10_000, "the last node finishes its queue");
  return { journal, seen };
}

test("run lifecycle: one terminal outcome per accepted run, never changed; resumes capped; queued work never dropped", async t => {
  await check(t, fc.property(fc.array(op, { maxLength: 60 }), ops => {
    const { journal, seen } = simulate(ops);
    const latest = new Map<string, RequestRecord>();
    const terminal = new Map<string, RequestRecord>();
    for (const entry of journal.durable) {
      // Once an outcome is durable, the request never runs again, and its outcome never changes.
      const ended = terminal.get(entry.id);
      if (ended) assert.deepEqual(entry, ended, `${entry.id} changed after its outcome was durable`);
      if (entry.state === "completed") terminal.set(entry.id, entry);
      latest.set(entry.id, entry);
    }
    for (const id of seen.accepted) {
      const final = latest.get(id);
      // Liveness: every accepted request ends once a node runs without faults.
      assert.equal(final?.state, "completed", `${id} never ended`);
      // An uncertain outcome only for a run that durably began: queued work is never failed or dropped.
      const durablyBegan = journal.durable.some(entry => entry.id === id && entry.began !== undefined && entry.params === undefined);
      if (final!.outcome && "uncertain" in final!.outcome && final!.outcome.uncertain) assert.ok(durablyBegan, `${id} failed as uncertain without having begun`);
      // At most one outcome published, and it is the durable one.
      const published = seen.published.get(id) ?? [];
      assert.ok(published.length <= 1, `${id} published ${published.length} outcomes`);
      if (published.length) assert.deepEqual(published[0], final!.outcome);
      // A model turn begins at most once plus MAX_RESUMES resumes; its resume count never passes the cap.
      if (["prompt", "continue"].includes(final!.method)) {
        assert.ok((final!.resumes ?? 0) <= MAX_RESUMES, `${id} resumed ${final!.resumes} times`);
      }
      // An execution has an effect at most once: one that crashed before its first tool call reruns from its params.
      if (final!.method === "execute") assert.ok((seen.effects.get(id) ?? 0) <= 1, `${id} had ${seen.effects.get(id)} effects`);
    }
    // Every model run has at most 1 + MAX_RESUMES beginnings with effects after them, besides those after hand-offs.
    for (const [id, effects] of seen.effects) {
      const final = latest.get(id)!;
      if (["prompt", "continue"].includes(final.method)) assert.ok(effects <= 1 + MAX_RESUMES + (seen.handoffs.get(id) ?? 0), `${id} had ${effects} effects`);
    }
  }), { runs: 300 });
});

// --- Transcript repair -----------------------------------------------------------------------------------------------

type Step = { calls: { id: string; name: string }[]; answered: number; order: number[] };
/**
 * A valid transcript cut at any point, as a lost node leaves it: turns of a user message and steps of an assistant
 * message with tool calls, each answered (in any order), ending with a final assistant message; the cut may fall mid-step,
 * with some calls answered and others not, or right after a user message.
 */
const transcript = fc.array(fc.record({
  steps: fc.array(fc.array(fc.constantFrom("js_exec", "delegate", "search", "write_file"), { minLength: 0, maxLength: 3 }), { maxLength: 3 }),
  finished: fc.boolean(),
}), { minLength: 1, maxLength: 4 }).chain(turns => fc.tuple(fc.constant(turns), fc.nat(), fc.array(fc.nat(), { maxLength: 12 }))).map(([turns, cutSeed, orderSeeds]) => {
  const messages: AgentMessage[] = [];
  let call = 0;
  turns.forEach((turn, index) => {
    messages.push({ role: "user", content: `turn ${index}`, timestamp: 0 } as AgentMessage);
    for (const names of turn.steps) {
      const calls = names.map(name => ({ id: `call_${call++}`, name }));
      messages.push({ role: "assistant", content: [{ type: "text", text: "working" }, ...calls.map(c => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} }))], stopReason: calls.length ? "toolUse" : "stop", timestamp: 0 } as unknown as AgentMessage);
      // Results in any order.
      const order = calls.map((c, i) => ({ c, k: orderSeeds[(call + i) % Math.max(1, orderSeeds.length)] ?? i })).sort((a, b) => a.k - b.k).map(entry => entry.c);
      for (const c of order) messages.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as AgentMessage);
    }
    if (turn.finished) messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 0 } as unknown as AgentMessage);
  });
  return messages.slice(0, 1 + (cutSeed % messages.length));
});

/**
 * Whether `messages` is a valid transcript: each tool result answers a call of the latest assistant message that is not
 * answered yet, and an assistant or user message comes only once every call before it is answered. Returns the calls
 * left open at the end (only those an interrupted turn may leave).
 */
function openAtEnd(messages: AgentMessage[]) {
  let open = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      assert.ok(open.has(message.toolCallId), `message ${index} answers ${message.toolCallId}, which is not an open call`);
      assert.equal(message.toolName, open.get(message.toolCallId), `message ${index} names another tool than its call`);
      open.delete(message.toolCallId);
      continue;
    }
    assert.equal(open.size, 0, `message ${index} (${message.role}) comes before calls ${[...open.keys()]} are answered`);
    if (message.role === "assistant") open = new Map(message.content.filter(part => part.type === "toolCall").map(part => [(part as { id: string }).id, (part as { name: string }).name]));
  }
  return [...open.keys()];
}

test("transcript repair (close): every call answered exactly once, and the turn closed with a user message", async t => {
  await check(t, fc.property(transcript, context => {
    const open = openAtEnd(context);
    const repairs = interruptedTurnRepairs(context);
    const repaired = [...context, ...repairs];
    assert.deepEqual(openAtEnd(repaired), []);
    assert.equal(repaired.at(-1)!.role, "user");
    // Exactly one result per open call: the unknown outcome, as an error, never a claim it ran or did not.
    const results = repairs.filter(message => message.role === "toolResult");
    assert.deepEqual(results.map(message => message.toolCallId).sort(), [...open].sort());
    for (const result of results) assert.equal(result.isError, true);
  }), { runs: 400 });
});

test("transcript repair (resume): open calls and the repairs agree; awaited and rerun calls stay open, the rest are answered once", async t => {
  await check(t, fc.property(transcript, fc.array(fc.nat({ max: 20 })), (context, picks) => {
    const open = openAtEnd(context);
    // The host's own view of what is open (`openCalls`) is the repairs' view.
    assert.deepEqual(openCalls(context).map(call => call.id).sort(), [...open].sort());
    // Calls awaiting input (or rerun on resume) are left open; ids that are not open calls are ignored.
    const awaiting = [...new Set(picks.map(pick => `call_${pick}`))];
    const repaired = [...context, ...interruptedTurnRepairs(context, false, awaiting)];
    assert.deepEqual(openAtEnd(repaired).sort(), open.filter(id => awaiting.includes(id)).sort());
    // As `init` resumes a turn: rerun calls (delegate) stay open for the turn to make again.
    const rerun = openCalls(context).filter(call => RERUN.includes(call.name)).map(call => call.id);
    const resumed = [...context, ...interruptedTurnRepairs(context, false, rerun)];
    assert.deepEqual(openAtEnd(resumed).sort(), [...rerun].sort());
    // Repairing twice adds nothing: a repaired transcript has nothing left to close but what was left open on purpose.
    assert.deepEqual(interruptedTurnRepairs(resumed, false, rerun), []);
  }), { runs: 400 });
});
