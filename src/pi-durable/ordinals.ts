import type { EntryRecord, StorageWrite } from "@earendil-works/pi-durable";
import { transaction, type Db } from "../db.ts";
/** `history.ts`'s MARKER_KIND and `seed.ts`'s SESSION_CONVERSATION_ID: storage.ts imports this module, which imports neither (a cycle). */
export const MARKER_KIND = "camel.history.marker";
const SESSION_CONVERSATION_ID = 1;

/**
 * Each history entry's place in its agent's history, kept in Pi's own storage (plans/thin-host-slimdown-2.md §6.1 H1):
 * an entry whose messages are history holds messages `msg_from` .. `msg_from + msg_count - 1` (its own history messages
 * from its `msg_skip`-th on), and a marker that opens a turn has `turn_start` at `msg_from`. So a page of history is a
 * range of rows by ordinal, read in SQL, never a scan from the start.
 *
 * `PostgresPiStorage.commit` places each entry as it is committed (`placeEntries`), as `JournalHistory` counts the
 * journal: native messages are history in entry ID order, a `retract` marker takes back the latest one (the next message
 * takes its place), and a `base` marker opens the history at its `total` (its `kept`: the running turn's messages from
 * before it, held in the marker). An agent's ordinals start null (`history_next`): `fillOrdinals` places a session's
 * entries from its first base on, once (POST /v1/operations/history-ordinals).
 */

/** The entry kinds that hold history messages (`durableEntryMessages` reads only these). */
const NATIVE_KINDS = new Set(["pi.user", "pi.assistant", "pi.tool-result", "camel.user", "camel.message"]);

/** Where an entry's history messages are among its model messages (`durableEntryMessages`' cursors' indexes). */
export function historyPositions(entry: Pick<EntryRecord, "kind" | "model" | "data">): number[] {
  if (!NATIVE_KINDS.has(entry.kind) || !entry.model?.length) return [];
  // A user message the host keeps whole in its data is one message, whatever its model form.
  if (entry.kind === "camel.user" && (entry.data as { message?: unknown } | undefined)?.message) return [0];
  return entry.model.flatMap((message, index) =>
    message.role === "toolResult" && (message.details as { inputRequired?: boolean } | undefined)?.inputRequired ? [] : [index]);
}

/** An entry's place: see the module. */
export type Placement = { from: number; count: number; skip: number; turn: boolean };
/** A session's history length (`next`) and its newest entry placed (`lastId`); `next` null: not placed yet. */
export type OrdinalState = { next: number | null; lastId: number };

type Executor = {
  get<T>(query: string, ...params: unknown[]): Promise<T | undefined>;
  run(query: string, ...params: unknown[]): Promise<void>;
};
const ENTRIES = "pi_durable_entries";
type Marker = { t?: string; total?: number; kept?: unknown[]; active?: boolean };

/**
 * The places of a commit's session entries, worked out under the commit's metadata lock (`state` as the row holds it).
 * An entry committed after one with a later ID (Pi and the host commit on their own) takes the place of the first
 * message after it, and those after it move up. A `pi` marker (the host's skip of a discarded run's messages) unplaces
 * the session, for `fillOrdinals` to place again. Earlier rows are changed here, the commit's own rows by `placements`.
 */
export async function placeEntries(sql: Executor, writes: readonly StorageWrite[], state: OrdinalState): Promise<{ placements: Map<number, Placement>; state: OrdinalState } | undefined> {
  const entries = writes.flatMap(write => write.type === "entry" && write.value.conversationId === SESSION_CONVERSATION_ID ? [write.value] : []).sort((a, b) => a.id - b.id);
  if (state.next === null || !entries.length) return undefined;
  const placements = new Map<number, Placement>();
  let next = state.next, lastId = state.lastId;
  for (const entry of entries) {
    // Where the entry goes: at the history's end, or (committed late) before the first message placed after it.
    const late = entry.id < lastId;
    const at = late ? (await sql.get<{ at: number | null }>(`SELECT min(msg_from) AS at FROM ${ENTRIES} WHERE session_id = $1 AND conversation_id = ? AND id > ? AND msg_from IS NOT NULL`, SESSION_CONVERSATION_ID, entry.id))?.at ?? next : next;
    lastId = Math.max(lastId, entry.id);
    if (entry.kind === MARKER_KIND) {
      const marker = (entry.data ?? {}) as Marker;
      if (marker.t === "base" && typeof marker.total === "number" && marker.total !== next) {
        const kept = Array.isArray(marker.kept) ? marker.kept.length : 0;
        // A new session's first base opens its history (a fork's starts past the messages it copied); any later one
        // stands where the history does, so one that does not is reported and left out.
        if (next === 0 && !placements.size) {
          next = marker.total;
          if (kept) placements.set(entry.id, { from: next - kept, count: kept, skip: 0, turn: false });
        } else console.error(JSON.stringify({ type: "history_ordinal_mismatch", entry: entry.id, base: marker.total, next }));
      } else if (marker.t === "retract") {
        if (next <= 0) { console.error(JSON.stringify({ type: "history_ordinal_mismatch", entry: entry.id, retract: true, next })); continue; }
        const held = [...placements].find(([, place]) => place.count > 0 && place.from + place.count === next);
        if (held) { held[1].count--; if (!held[1].count) placements.delete(held[0]); }
        else await sql.run(`UPDATE ${ENTRIES} SET msg_count = CASE WHEN msg_count = 1 THEN NULL ELSE msg_count - 1 END, msg_from = CASE WHEN msg_count = 1 THEN NULL ELSE msg_from END
          WHERE session_id = $1 AND msg_from IS NOT NULL AND msg_count > 0 AND msg_from + msg_count = ?`, next);
        next--;
      } else if (marker.t === "turn" && marker.active) placements.set(entry.id, { from: at, count: 0, skip: 0, turn: true });
      else if (marker.t === "pi") {
        console.error(JSON.stringify({ type: "history_ordinals_unplaced", entry: entry.id, reason: "skip" }));
        return { placements: new Map(), state: { next: null, lastId: 0 } };
      }
      continue;
    }
    const count = historyPositions(entry).length;
    if (!count) continue;
    placements.set(entry.id, { from: at, count, skip: 0, turn: false });
    if (at < next) await sql.run(`UPDATE ${ENTRIES} SET msg_from = msg_from + ? WHERE session_id = $1 AND conversation_id = ? AND id > ? AND msg_from IS NOT NULL`, count, SESSION_CONVERSATION_ID, entry.id);
    next += count;
  }
  return { placements, state: { next, lastId } };
}

/** An entry as `fillOrdinals` reads it: its history positions, and a marker's data (without a base's `kept` and `calls`, but their count). */
export type EntryShape = { id: number; kind: string; positions: number[]; marker?: Marker & { cursor?: At; after?: At; through?: At }; kept?: number };
type At = { entryId: number; index: number };
const after = (a: At, b: At) => a.entryId > b.entryId || a.entryId === b.entryId && a.index > b.index;

/**
 * A session's places as its journal gives them: `JournalHistory`'s count, read in ID order from the session's first base
 * (not its latest), so every message since is placed. `apply` takes every session entry from where the base's cursor
 * stands (else from the base) on; each later base must stand where the history does, and each entry's messages must be
 * one run of the history and of its own history messages, else the session is `irregular`.
 */
export class OrdinalReplay {
  private readonly base: EntryShape;
  private readonly heldFrom: number;
  /** The history's messages from heldFrom on: the entry each is in, and which of its history messages it is (a kept one: the base marker's slot). */
  private ids: number[] = [];
  private locals: number[] = [];
  /** Model indexes, for a skip's cursors (-1: one of the base's kept messages, never skipped). */
  private indexes: number[] = [];
  private turns = new Map<number, number>();
  lastId: number;
  irregular?: string;

  constructor(base: EntryShape) {
    this.base = base;
    const kept = base.kept ?? 0;
    this.heldFrom = base.marker!.total! - kept;
    for (let slot = 0; slot < kept; slot++) { this.ids.push(base.id); this.locals.push(slot); this.indexes.push(-1); }
    this.lastId = base.id;
  }

  get total() { return this.heldFrom + this.ids.length; }

  apply(shape: EntryShape) {
    if (this.irregular) return;
    this.lastId = Math.max(this.lastId, shape.id);
    if (shape.kind === MARKER_KIND) {
      // Markers count from the base on; those before it are in its counts.
      if (shape.id <= this.base.id) return;
      const marker = shape.marker ?? {};
      if (marker.t === "retract") {
        if (!this.ids.length) { this.irregular = `retract ${shape.id} has no message to take back`; return; }
        this.ids.pop(); this.locals.pop(); this.indexes.pop();
      } else if (marker.t === "turn" && marker.active) this.turns.set(shape.id, this.total);
      else if (marker.t === "pi" && marker.cursor) {
        // Journal messages the host skipped (Pi's results for an interrupted run it discarded): not history.
        const keep = this.ids.map((entryId, index) => {
          const at = { entryId, index: this.indexes[index] };
          return this.indexes[index] < 0 || (marker.after && !after(at, marker.after)) || after(at, marker.cursor!);
        });
        this.ids = this.ids.filter((_, index) => keep[index]);
        this.locals = this.locals.filter((_, index) => keep[index]);
        this.indexes = this.indexes.filter((_, index) => keep[index]);
      } else if (marker.t === "base" && typeof marker.total === "number" && marker.total !== this.total) {
        this.irregular = `base ${shape.id} stands at ${marker.total}, the history at ${this.total}`;
      }
      return;
    }
    const through = this.base.marker!.through;
    shape.positions.forEach((index, local) => {
      if (through && !after({ entryId: shape.id, index }, through)) return;
      this.ids.push(shape.id); this.locals.push(local); this.indexes.push(index);
    });
  }

  /** Each entry's place; undefined (with `irregular` saying why) where an entry's messages are not one run. */
  placements(): Map<number, Placement> | undefined {
    if (this.irregular) return undefined;
    const placements = new Map<number, Placement>();
    for (let index = 0; index < this.ids.length; index++) {
      const id = this.ids[index], current = placements.get(id);
      if (!current) { placements.set(id, { from: this.heldFrom + index, count: 1, skip: this.locals[index], turn: false }); continue; }
      if (current.from + current.count !== this.heldFrom + index || current.skip + current.count !== this.locals[index]) {
        this.irregular = `entry ${id}'s history messages are not one run of the history`;
        return undefined;
      }
      current.count++;
    }
    for (const [id, from] of this.turns) placements.set(id, { from, count: 0, skip: 0, turn: true });
    return placements;
  }
}

/** What `fillOrdinals` did with an agent (in a dry run, `would_place` for `placed`). */
export const FILL_CODES = [
  "placed", "would_place",
  /** Placed already, with every session entry since. */
  "current",
  /** No Pi storage, or no base marker in it (a session from before journal history, which loads refuse): nothing to place. */
  "no_journal", "no_base",
  /** More session entries than `maxEntries`: not read. */
  "too_large",
  /** Its journal does not count as `JournalHistory` expects (`error` says where): left unplaced, for a person. */
  "irregular",
  /** Placing failed (`error`); a later call tries again. */
  "failed",
] as const;
export type FillCode = typeof FILL_CODES[number];
export type FillResult = { agent: string; code: FillCode; entries?: number; messages?: number; total?: number; error?: string };

/** The most session entries `fillOrdinals` reads by default, and at most. */
export const FILL_DEFAULT_ENTRIES = 200_000;
export const FILL_MAX_ENTRIES = 2_000_000;
/** Entries read at a time: their records are parsed in Postgres, each page within the statement timeout. */
const FILL_PAGE = 250;
const FILL_WRITES = 5_000;
const FILL_STATEMENT_TIMEOUT_MS = 20_000;

/**
 * Entries' shapes, read in Postgres: their records never come to the node. The SQL mirrors `historyPositions` (a test
 * holds them equal).
 */
const SHAPE = `e.id, r->>'kind' AS kind,
  CASE WHEN r->>'kind' = '${MARKER_KIND}' AND jsonb_typeof(r->'data') = 'object' THEN (r->'data') - 'kept' - 'calls' END AS marker,
  CASE WHEN r->>'kind' = '${MARKER_KIND}' AND jsonb_typeof(r->'data'->'kept') = 'array' THEN jsonb_array_length(r->'data'->'kept') ELSE 0 END AS kept,
  CASE WHEN r->>'kind' = ANY($3::text[]) AND jsonb_typeof(r->'model') = 'array' AND jsonb_array_length(r->'model') > 0 THEN
    CASE WHEN r->>'kind' = 'camel.user' AND jsonb_typeof(r->'data'->'message') = 'object' THEN ARRAY[0]
    ELSE (SELECT coalesce(array_agg(m.o - 1 ORDER BY m.o), '{}') FROM jsonb_array_elements(r->'model') WITH ORDINALITY m(v, o)
          WHERE NOT (m.v->>'role' = 'toolResult' AND coalesce(m.v->'details'->>'inputRequired', '') = 'true')) END
  ELSE '{}' END AS positions`;
type ShapeRow = { id: string | number; kind: string; marker: EntryShape["marker"] | null; kept: number; positions: number[] };
const shapeOf = (row: ShapeRow): EntryShape => ({ id: Number(row.id), kind: row.kind, positions: row.positions, ...(row.marker ? { marker: row.marker } : {}), kept: row.kept });

/**
 * Place a session's entries from its first base on (`OrdinalReplay`), under its metadata row's lock (its commits wait),
 * and set its history's length: once, as a session placed and current is left alone, and again for one written since
 * by a release that did not place (its newest entry past `history_last_id`). A dry run reads, locks and writes nothing.
 * Every statement is stopped after `statementTimeoutMs`; records are read in Postgres, a page at a time.
 */
export async function fillOrdinals(db: Db, agent: string, options: { dryRun: boolean; maxEntries?: number; statementTimeoutMs?: number }): Promise<FillResult> {
  const maxEntries = Math.min(FILL_MAX_ENTRIES, options.maxEntries ?? FILL_DEFAULT_ENTRIES);
  return transaction(db, async sql => {
    await sql.query(`set local statement_timeout = ${Math.floor(options.statementTimeoutMs ?? FILL_STATEMENT_TIMEOUT_MS)}`);
    const meta = (await sql.query<{ history_next: number | null; history_last_id: string | null }>(
      `select history_next, history_last_id from pi_durable_metadata where session_id = $1${options.dryRun ? "" : " for update"}`, [agent])).rows[0];
    if (!meta) return { agent, code: "no_journal" };
    const range = (await sql.query<{ last: string | null; entries: string }>(
      "select max(id) as last, count(*) as entries from pi_durable_entries where session_id = $1 and conversation_id = $2", [agent, SESSION_CONVERSATION_ID])).rows[0];
    const last = Number(range.last ?? 0), entries = Number(range.entries);
    if (meta.history_next !== null && Number(meta.history_last_id ?? 0) >= last) return { agent, code: "current", total: meta.history_next };
    if (entries > maxEntries) return { agent, code: "too_large", entries };
    const natives = [...NATIVE_KINDS];
    const baseRow = (await sql.query<ShapeRow>(`SELECT ${SHAPE} FROM (SELECT id, record::jsonb AS r FROM pi_durable_entries
      WHERE session_id = $1 AND conversation_id = $2 AND substr(record, 1, 200) LIKE '%"kind":"${MARKER_KIND}"%' AND strpos(record, '"t":"base"') > 0) e
      WHERE r->>'kind' = '${MARKER_KIND}' AND r->'data'->>'t' = 'base' ORDER BY e.id LIMIT 1`, [agent, SESSION_CONVERSATION_ID, natives])).rows[0];
    if (!baseRow) {
      if (entries) return { agent, code: "no_base", entries };
      // No entries yet: an empty history, which the session's first base opens.
      if (!options.dryRun) await sql.query("update pi_durable_metadata set history_next = 0, history_last_id = 0 where session_id = $1", [agent]);
      return { agent, code: options.dryRun ? "would_place" : "placed", entries: 0, messages: 0, total: 0 };
    }
    const base = shapeOf(baseRow);
    const replay = new OrdinalReplay(base);
    let from = Math.min(base.id, base.marker?.through?.entryId ?? base.id);
    for (;;) {
      const { rows } = await sql.query<ShapeRow>(`SELECT ${SHAPE} FROM (SELECT id, record::jsonb AS r FROM pi_durable_entries
        WHERE session_id = $1 AND conversation_id = $2 AND id >= $4 ORDER BY id LIMIT $5) e ORDER BY e.id`, [agent, SESSION_CONVERSATION_ID, natives, from, FILL_PAGE]);
      for (const row of rows) replay.apply(shapeOf(row));
      if (rows.length < FILL_PAGE) break;
      from = Number(rows.at(-1)!.id) + 1;
    }
    const placements = replay.placements();
    if (!placements) return { agent, code: "irregular", entries, error: replay.irregular };
    const result = { agent, entries, messages: replay.total - (base.marker!.total! - (base.kept ?? 0)), total: replay.total };
    if (options.dryRun) return { ...result, code: "would_place" };
    await sql.query("update pi_durable_entries set msg_from = null, msg_count = null, msg_skip = 0, turn_start = false where session_id = $1 and (msg_from is not null or turn_start)", [agent]);
    const rows = [...placements];
    for (let at = 0; at < rows.length; at += FILL_WRITES) {
      const part = rows.slice(at, at + FILL_WRITES);
      await sql.query(`update pi_durable_entries e set msg_from = u.f, msg_count = u.c, msg_skip = u.s, turn_start = u.t
        from unnest($2::bigint[], $3::int[], $4::int[], $5::int[], $6::boolean[]) u(id, f, c, s, t) where e.session_id = $1 and e.id = u.id`,
        [agent, part.map(([id]) => id), part.map(([, place]) => place.from), part.map(([, place]) => place.count), part.map(([, place]) => place.skip), part.map(([, place]) => place.turn)]);
    }
    await sql.query("update pi_durable_metadata set history_next = $2, history_last_id = $3 where session_id = $1", [agent, replay.total, Math.max(replay.lastId, last)]);
    return { ...result, code: "placed" };
  });
}
