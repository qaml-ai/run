import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { ClientSessions, EVENT_BLOCK } from "../src/client-sessions.ts";
import { HttpError } from "../src/http.ts";
import { FRAME_BYTES, type ClientEvent, type TurnSnapshot } from "../shared/client-protocol.ts";
import type { Db } from "../src/db.ts";
import type { Storage } from "../shared/storage.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";
import { check, fc } from "./prop-helpers.ts";

/**
 * I8 (design §3): a watcher that resumes with Last-Event-ID gets exactly the events published after that id, in order,
 * without duplicates, or is told it cannot (409 REPLAY_GAP, or a snapshot when it asked for one); event ids are never
 * reused for an agent. The buffer, ids and replay are ClientSessions' own (`publish`, `replay`), driven on a bare
 * session; across owners, the cursor a load starts from and the ids it reserves are `startCursor`'s and
 * `reserveEvents`', on Postgres.
 */
const MAX_BUFFERED_EVENTS = 512;

type Buffered = { id: number; bytes: number; data: ClientEvent };
type Replayed = { cursor: number; snapshot?: TurnSnapshot; events: Buffered[] };
/** The session fields `publish` and `replay` use. */
type BareSession = {
  header: { id: string; tenant: string }; cursor: number; reserved: number; reserving?: Promise<void>; held?: ClientEvent[];
  events: Buffered[]; eventBytes: number; watchers: Set<unknown>; polls: Set<() => void>; lastActive: number;
};
type Internals = {
  publish(session: BareSession, data: ClientEvent): void; replay(session: BareSession, raw?: string, snapshot?: boolean): Replayed; close(): Promise<void>;
  startCursor(id: string, claim: undefined): Promise<{ cursor: number; reserved: number }>; idleCursor(id: string): Promise<number | undefined>;
};

const nodes: Internals[] = [];
after(async () => { for (const node of nodes) await node.close(); });
/** A node with nothing loaded: only its event plumbing is used, and its database only for event ids. */
function node(eventBytes?: number, options: { db?: Db; eventBlock?: number } = {}): Internals {
  const supervisor = { agents: new Map(), flush: async () => {}, stop: async () => {} } as unknown as AgentSupervisor;
  const made = new ClientSessions(supervisor, { secret: "s".repeat(32), db: options.db ?? {} as Db, storage: {} as Storage, ...(eventBytes ? { eventBytes } : {}), ...(options.eventBlock ? { eventBlock: options.eventBlock } : {}) }) as unknown as Internals;
  nodes.push(made);
  return made;
}
const bare = (cursor: number, reserved = Number.MAX_SAFE_INTEGER, id = "agent"): BareSession => ({ header: { id, tenant: "tenant" }, cursor, reserved, events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), lastActive: 0 });

/** Events of every kind and size, a few past the transport's frame limit (published as `event_omitted`). */
const event: fc.Arbitrary<ClientEvent> = fc.oneof(
  { weight: 6, arbitrary: fc.nat({ max: 3_000 }).map(size => ({ type: "event" as const, requestId: "run", event: { type: "tool_execution_update", text: "x".repeat(size) } })) },
  { weight: 1, arbitrary: fc.nat({ max: 20_000 }).map(size => ({ type: "event" as const, requestId: "run", event: { type: "tool_execution_update", text: "y".repeat(FRAME_BYTES + size) } })) },
  { weight: 2, arbitrary: fc.string({ maxLength: 8 }).map(id => ({ type: "response" as const, id, outcome: { result: id } })) },
);

/** Replay `raw` and classify it: the events it serves, a snapshot, or the HTTP error it throws (never another error). */
function replay(node: Internals, session: BareSession, raw: string, snapshot = false) {
  try {
    const result = node.replay(session, raw, snapshot);
    return result.snapshot ? { snapshot: result.snapshot } : { events: result.events };
  } catch (error) {
    assert.ok(error instanceof HttpError, `replay threw ${String(error)}`);
    return { status: error.status, message: error.message };
  }
}

test("replay: an exact suffix of what was published, or 409/snapshot when the buffer cannot serve it", async t => {
  await check(t, fc.asyncProperty(fc.array(event, { maxLength: 40 }), fc.integer({ min: 4_000, max: 400_000 }), fc.nat({ max: 1_000_000 }), fc.array(fc.integer({ min: -3, max: 45 }), { maxLength: 8 }), async (events, limit, start, offsets) => {
    const server = node(limit);
    const session = bare(start);
    const published: Buffered[] = [];
    for (const data of events) {
      server.publish(session, data);
      // What the stream sent under that id: the buffer's newest event.
      published.push(session.events.at(-1)!);
      assert.equal(session.events.at(-1)!.id, session.cursor);
    }
    // Ids are consecutive from the start cursor, and the buffer is a contiguous, bounded suffix of them.
    assert.deepEqual(published.map(entry => entry.id), events.map((_, index) => start + 1 + index));
    assert.deepEqual(session.events, published.slice(published.length - session.events.length));
    assert.ok(session.events.length <= MAX_BUFFERED_EVENTS);
    assert.ok(session.events.length <= 1 || session.eventBytes <= limit, "the buffer stays within its bytes, but for its newest event");
    assert.equal(session.eventBytes, session.events.reduce((sum, entry) => sum + entry.bytes, 0));
    const first = session.events[0]?.id ?? session.cursor + 1;
    for (const offset of [0, ...offsets]) {
      const cursor = offset === 0 ? 0 : Math.max(0, start + offset);
      const got = replay(server, session, String(cursor));
      const servable = cursor === 0 || (cursor >= first - 1 && cursor <= session.cursor);
      if (!servable) { assert.equal(got.status, 409, `cursor ${cursor} (buffer ${first}..${session.cursor}) must be a gap`); continue; }
      // Exactly the events after it, in order, none twice; a new subscriber (0) gets what is buffered.
      assert.deepEqual(got.events, cursor === 0 ? session.events : published.filter(entry => entry.id > cursor));
      // Asking for a snapshot changes only what a gap (or a new subscriber) gets.
      const snap = replay(server, session, String(cursor), true);
      if (cursor === 0) assert.equal(snap.snapshot?.cursor, session.cursor);
      else assert.deepEqual(snap.events, got.events);
    }
    for (const offset of offsets) {
      const cursor = start + offset;
      if (cursor > 0 && (cursor < first - 1 || cursor > session.cursor)) assert.equal(replay(server, session, String(cursor), true).snapshot?.cursor, session.cursor);
    }
  }), { runs: 150 });
});

test("replay: any Last-Event-ID text is served, refused with 400, or a 409 gap, never another error", async t => {
  const server = node();
  const session = bare(41);
  for (let index = 0; index < 5; index++) server.publish(session, { type: "response", id: String(index), outcome: { result: index } });
  await check(t, fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[0-9]{1,25}$/), fc.constantFrom("", "-1", "1e3", "0x10", " 42", "42 ", "9007199254740993")), raw => {
    const got = replay(server, session, raw);
    if (got.status !== undefined) assert.ok([400, 409].includes(got.status), `status ${got.status}`);
    else assert.ok(/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)));
  }), { runs: 300 });
});

// --- Event ids across owners (H2) ------------------------------------------------------------------------------------

let db: pg.Pool;
before(async () => { ({ db } = await testDatabase()); });

/** Run `work` with this process's clock reading `now` (ms), as a node whose clock is off would. */
async function at<T>(now: number, work: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => now;
  try { return await work(); } finally { Date.now = real; }
}

/**
 * One owner of the agent after another, on Postgres, as its `agents` row (`last_cursor`, `cursor_clean`,
 * `reserved_cursor`) carries the cursor between them: each loads (`startCursor` on its own clock: where it starts, its
 * first block of ids reserved, the row marked unclean), publishes (reserving further blocks, `block` ids at a time, as
 * it goes), and stops cleanly (writing its cursor, clean, as `unload` does) or crashes (writing nothing). Between
 * owners, a node may serve an idle watcher (`idleCursor`, on that node's clock). Owners follow one another in real time
 * (a takeover takes at least `gapMs`); each node's clock is off by its offset.
 */
type Owner = { offsetMs: number; gapMs: number; durationMs: number; events: number; clean: boolean; idle?: { offsetMs: number } };
/** Owners whose clocks are off by up to `skewMs`, with idle watchers between them on clocks off by up to `idleSkewMs` (none if undefined). */
const owners = (skewMs: number, idleSkewMs: number | undefined) => fc.array(fc.record({
  offsetMs: fc.integer({ min: -skewMs, max: skewMs }), gapMs: fc.integer({ min: 1_000, max: 120_000 }), durationMs: fc.integer({ min: 1, max: 600_000 }),
  events: fc.integer({ min: 0, max: 50 }), clean: fc.boolean(),
  idle: idleSkewMs === undefined ? fc.constant(undefined) : fc.option(fc.record({ offsetMs: fc.integer({ min: -idleSkewMs, max: idleSkewMs }) }), { nil: undefined }),
}), { minLength: 2, maxLength: 5 }) as fc.Arbitrary<Owner[]>;
/** Block sizes small enough that owners run out of reserved ids, and the real one. */
const block = fc.oneof(fc.integer({ min: 1, max: 64 }), fc.constant(EVENT_BLOCK));

/**
 * Run the owners and check I8 across them: no event id is ever published twice, and a watcher holding any id it was
 * sent, reconnecting to a later owner, is told of the gap (409) unless nothing was published since that id.
 */
async function runOwners(list: Owner[], eventBlock = EVENT_BLOCK) {
  const server = node(undefined, { db, eventBlock });
  const agent = `agent_${randomBytes(6).toString("hex")}`;
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'tenant', '{}', 1, $1, 'general', 'm')", [agent]);
  let now = 1_760_000_000_000;
  const used = new Map<number, number>();
  const seen: { id: number; owner: number }[] = [];
  for (const [index, owner] of list.entries()) {
    now += owner.gapMs;
    if (owner.idle) await at(now + owner.idle.offsetMs, () => server.idleCursor(agent));
    const { cursor: start, reserved } = await at(now + owner.offsetMs, () => server.startCursor(agent, undefined));
    const session = bare(start, reserved, agent);
    // A watcher that held an earlier owner's id reconnects here: a gap, unless that id is where this owner starts.
    for (const held of seen) {
      const got = replay(server, session, String(held.id));
      // Only the agent's latest event (its owner stopped cleanly there) may be where the next owner starts.
      if (held.id === start && held === seen.at(-1)) assert.ok(got.events, `owner ${index} starts at ${start}, which a watcher holds: it is caught up`);
      else assert.equal(got.status, 409, `owner ${index} (from ${start}) served a watcher holding owner ${held.owner}'s id ${held.id} without a gap`);
    }
    for (let event = 0; event < owner.events; event++) server.publish(session, { type: "response", id: `${index}.${event}`, outcome: { result: event } });
    // Events past the reserved ids wait for the next block: all are out once it is reserved.
    while (session.held) await session.reserving;
    await session.reserving;
    const ids = session.events.map(entry => entry.id);
    assert.deepEqual(ids, Array.from({ length: owner.events }, (_, offset) => start + 1 + offset), "consecutive ids, in the order published");
    const stored = Number((await db.query("select reserved_cursor from agents where id = $1", [agent])).rows[0].reserved_cursor);
    assert.ok(session.cursor <= stored, `published ${session.cursor}, past the ${stored} reserved`);
    for (const id of ids) {
      assert.ok(!used.has(id), `event id ${id} of owner ${index} was already used by owner ${used.get(id)}`);
      used.set(id, index);
      seen.push({ id, owner: index });
    }
    now += owner.durationMs;
    // A clean stop, as `unload` writes it.
    if (owner.clean) await db.query("update agents set last_cursor = $2, cursor_clean = true where id = $1", [agent, session.cursor]);
  }
}

test("event ids are never reused across owners whose clocks agree", async t => {
  await check(t, fc.asyncProperty(owners(0, 0), block, (list, size) => runOwners(list, size)), { runs: 60 });
});

/**
 * H2 (fixed): event ids were reused after an unclean stop when node clocks disagreed, and a watcher holding one of the
 * reused ids resumed mid-stream on the new owner, missing events, with no 409. A load bounded an unclean owner's ids
 * only by its clock, `max(now * 1000, stored + 1)`, where `stored` was the cursor of the last clean stop: the ids an
 * owner published were recorded nowhere until it stopped cleanly. Now an owner reserves its ids (`reserved_cursor`,
 * under its claim) before publishing them, and an unclean load starts above every id reserved.
 *
 * The counterexamples fast-check found (seeds 1970555252 and -2057697516, minimized):
 *   skew:          owner 0 stops clean with no events; owner 1 publishes 2 and crashes; owner 2, 1 s later on a clock
 *                  2.002 s behind, started at owner 1's start + 1.
 *   skew history:  an idle watcher's node runs ahead; owner 0 loads clean from its cursor, publishes, crashes; owner 1
 *                  (correct clock) reused owner 0's first id.
 */
const MINIMAL_SKEW: Owner[] = [
  { offsetMs: 0, gapMs: 1000, durationMs: 1, events: 0, clean: true },
  { offsetMs: 0, gapMs: 1000, durationMs: 1, events: 2, clean: false },
  { offsetMs: -2002, gapMs: 1000, durationMs: 1, events: 0, clean: false },
];
const MINIMAL_HISTORY: Owner[] = [
  { offsetMs: 0, gapMs: 1000, durationMs: 1, events: 2, clean: false, idle: { offsetMs: 120_004 } },
  { offsetMs: 0, gapMs: 1000, durationMs: 1, events: 0, clean: false },
];
test("H2 minimized: a successor on a clock behind its crashed predecessor's", () => runOwners(MINIMAL_SKEW));
test("H2 minimized: a cursor stored from a clock that ran ahead", () => runOwners(MINIMAL_HISTORY));

test("H2: no event id is reused after an unclean stop under clock skew", async t => {
  await check(t, fc.asyncProperty(owners(300_000, undefined), block, (list, size) => runOwners(list, size)), { runs: 150 });
});

test("H2 (skew history): one fast clock does not let owners whose clocks agree reuse ids", async t => {
  await check(t, fc.asyncProperty(owners(0, 300_000), block, (list, size) => runOwners(list, size)), { runs: 150 });
});
