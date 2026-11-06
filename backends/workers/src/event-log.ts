export type TerminalEvents = { events: unknown[]; next: number };
export type TerminalDelivery = { key: string; index: number };
export const TERMINAL_EVENTS_PREFIX = "terminal-events:";

/** Commit beside the completed request, before either billing or event delivery. */
export async function enqueueTerminalEvents(
  tx: Pick<DurableObjectTransaction, "put">,
  id: string,
  outcome: unknown,
  agentEnd = true,
) {
  await tx.put(`${TERMINAL_EVENTS_PREFIX}${id}`, {
    events: [
      ...(agentEnd
        ? [{ type: "event", requestId: id, event: { type: "agent_end", messages: [] } }]
        : []),
      { type: "response", id, outcome },
    ],
    next: 0,
  } satisfies TerminalEvents);
}

/** Advance in the same transaction that appends the durable event and cursor. */
export async function acknowledgeTerminalEvent(
  tx: Pick<DurableObjectTransaction, "get" | "put" | "delete">,
  delivery: TerminalDelivery,
): Promise<boolean> {
  const pending = await tx.get<TerminalEvents>(delivery.key);
  if (!pending || pending.next !== delivery.index) return false;
  if (pending.next + 1 === pending.events.length) await tx.delete(delivery.key);
  else await tx.put(delivery.key, { ...pending, next: pending.next + 1 });
  return true;
}

/** Durable replay for run streams: a subscriber joins first, then replays through a fixed cursor. */
export class DurableEventLog {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS camel_events (cursor INTEGER PRIMARY KEY, request_id TEXT, body TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS camel_events_request ON camel_events(request_id,cursor)");
  }
  append(cursor: number, value: unknown) {
    const event=value as {type?:string;requestId?:string;id?:string};
    const id=event.requestId ?? (event.type==="response" ? event.id : undefined);
    // Single-use run sessions are purged at retention; long-lived agents keep their own history instead.
    if (id?.startsWith("run_")) this.sql.exec("INSERT OR IGNORE INTO camel_events(cursor,request_id,body) VALUES(?,?,?)",cursor,id,JSON.stringify(value));
  }
  read(id:string,after:number,before:number,limit=128):{cursor:number;body:string}[] {
    return [...this.sql.exec<{cursor:number;body:string}>("SELECT cursor,body FROM camel_events WHERE request_id=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT ?",id,after,before,limit)];
  }
}

