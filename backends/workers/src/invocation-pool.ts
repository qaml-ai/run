import type { DbClient } from "./postgres.ts";

type Connection = DbClient & { close(): Promise<void> };
type Slot = { client?: Connection; opening?: Promise<Connection>; failed: boolean; closing?: Promise<void> };
type Waiter = { resolve(slot: Slot): void; reject(error: Error): void };

const MAX_CONNECTIONS = 4;

/** A FIFO checkout queue owned by one AgentInvocation. */
export class InvocationPool {
  private readonly slots = new Set<Slot>();
  private readonly idle: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  private closing?: Promise<void>;

  private readonly open: () => Promise<Connection>;

  constructor(open: () => Promise<Connection>) { this.open = open; }

  private dispatch() {
    while (this.waiters.length && !this.closing) {
      const slot = this.idle.shift() ?? (this.slots.size < MAX_CONNECTIONS ? { failed: false } : undefined);
      if (!slot) return;
      this.slots.add(slot);
      this.waiters.shift()!.resolve(slot);
    }
  }

  private discard(slot: Slot): Promise<void> {
    return slot.closing ??= (async () => {
      const client = slot.client ?? await slot.opening?.catch(() => undefined);
      await client?.close().catch(() => {});
      this.slots.delete(slot);
      this.dispatch();
    })();
  }

  async connect(): Promise<Connection> {
    if (this.closing) throw new Error("Postgres invocation has ended");
    const slot = await new Promise<Slot>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.dispatch();
    });
    try {
      if (this.closing || slot.failed) throw new Error("Postgres checkout is unavailable");
      if (!slot.client) {
        const client = slot.client = await (slot.opening ??= this.open());
        client.on("error", () => {
          slot.failed = true;
          const index = this.idle.indexOf(slot);
          if (index >= 0) {
            this.idle.splice(index, 1);
            void this.discard(slot);
          }
        });
      }
      if (this.closing || slot.failed) throw new Error("Postgres checkout is unavailable");
      const client = slot.client;
      let released = false;
      const close = async () => {
        if (released) return;
        released = true;
        if (slot.failed || this.closing) await this.discard(slot);
        else {
          this.idle.push(slot);
          this.dispatch();
        }
      };
      return {
        query: async (text, values) => {
          if (released || this.closing) throw new Error("Postgres checkout has ended");
          try { return await client.query(text, values); }
          catch (error) { slot.failed = true; throw error; }
        },
        on: (event, listener) => client.on(event, listener),
        off: (event, listener) => client.off(event, listener),
        close,
        release: error => { if (error) slot.failed = true; void close(); },
      };
    } catch (error) {
      await this.discard(slot);
      throw error;
    }
  }

  end(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Postgres invocation has ended"));
      this.idle.length = 0;
      await Promise.all([...this.slots].map(slot => this.discard(slot)));
    });
  }
}
