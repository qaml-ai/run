// Generated from src/client-sessions/events.ts; only host types change.
import { HttpError } from './errors.ts';
import { FRAME_BYTES, type ClientEvent, type TurnSnapshot } from '../../../shared/client-protocol.ts';
export type LiveTurn = { requestId: string; start?: number; count: number; bytes: number; messages: any[]; truncated?: boolean };
type BufferedEvent = { id: number; data: any };
type Session = { events: BufferedEvent[]; cursor: number; turn?: LiveTurn; partial?: any };
type EventContext = { options: { snapshotBytes?: number } };
export const TURN_SNAPSHOT_BYTES = 1_000_000;
/** Keep the running turn as its events fold, for snapshots: the messages its run finished, from the run's start to its response. */
export function follow(session: Session, data: ClientEvent, text: string, oversized: boolean) {
  const turn = session.turn;
  if (!turn) return;
  if (data.type === "response" && data.id === turn.requestId) { session.turn = undefined; session.partial = undefined; return; }
  if (data.type !== "event" || data.requestId !== turn.requestId) return;
  const type = data.event?.type;
  if (type === "turn_opened") turn.start ??= data.event.index;
  // A response taken back (a retry, or a compaction on overflow) gives up its place, as it does for a subscriber folding the stream.
  if (type === "message_retracted" && turn.count) {
    turn.count--;
    if (!turn.truncated) turn.messages.pop();
  }
  if (type !== "message_end") return;
  // How many messages the run finished, whether or not the snapshot can carry them.
  turn.count++;
  turn.bytes += oversized ? FRAME_BYTES : text.length;
  // A snapshot is one frame: a turn too large for one is read from history instead.
  if (turn.truncated || turn.bytes > TURN_SNAPSHOT_BYTES) { turn.truncated = true; turn.messages = []; }
  else turn.messages.push(data.event.message);
}

/** The running turn as of the latest event, for a subscriber that asked for one and has nothing to replay from. */
export function turnSnapshot(ctx: EventContext, session: Session): TurnSnapshot {
  const turn = session.turn;
  const snapshot: TurnSnapshot = { type: "snapshot", cursor: session.cursor, requestId: turn?.requestId ?? null, turn: turn ? {
    start: turn.start ?? null, count: turn.count, messages: turn.messages, partial: session.partial ?? null, ...(turn.truncated ? { truncated: true as const } : {}),
  } : null };
  // Too large for one frame: the finished messages go first (they are in history), then the streaming message.
  const frame = ctx.options.snapshotBytes ?? FRAME_BYTES;
  if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, messages: [], truncated: true };
  if (snapshot.turn && Buffer.byteLength(JSON.stringify(snapshot)) > frame) snapshot.turn = { ...snapshot.turn, partial: null };
  return snapshot;
}

export function replay(session: Session, raw = "0", snapshot = false, snapshotBytes?: number): { cursor: number; snapshot?: TurnSnapshot; events: BufferedEvent[] } {
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "Invalid event cursor");
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid event cursor");
    const first = session.events[0]?.id ?? session.cursor + 1;
    const gap = cursor > session.cursor || cursor < first - 1;
    if (snapshot && (cursor === 0 || gap)) return { cursor: session.cursor, snapshot: turnSnapshot({ options: { snapshotBytes } }, session), events: [] };
    if (cursor !== 0 && gap) throw new HttpError(409, "REPLAY_GAP: recover from session state");
    return { cursor, events: session.events.filter(event => event.id > cursor) };
  }

