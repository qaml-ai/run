// The forks a workflow's children edit (workflow-volumes.ts) hold their base's content pinned for as long as they live.
// A workflow that ended has no use for them: its commits landed or never will. So the object records each fork it makes
// and deletes them all once the workflow has ended (completed, failed or aborted), which releases their pins. A delete
// that fails (storage down) is tried again on the object's alarm, later each time, and a crash in between loses nothing:
// a fork's record goes only after its volume is deleted, and deleting one twice is harmless.

const ROW = "workflow-fork:";
/** A pin of the result cache's, apart from the forks this workflow made: a pin alone never makes anything deletable. */
const PIN = "workflow-fork-pin:";
const RETRY = "workflow-fork-retry";
/** Kept while a commit() is in flight (WorkflowJobs' rows): its fork must outlive it. */
const IN_FLIGHT = "workflow-job:";
const FIRST_RETRY_MS = 60_000, MAX_RETRY_MS = 3_600_000;

export interface ForkJanitorHost {
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
  /** Delete fork `volume` (its row, then its object, which lets go of its base's pins). Throws when it could not. */
  deleteFork(volume: string): Promise<void>;
  now?: () => number;
}

export class ForkJanitor {
  private readonly host: ForkJanitorHost;
  constructor(host: ForkJanitorHost) { this.host = host; }
  private now() { return (this.host.now ?? Date.now)(); }

  /** A fork made for a child: recorded before the child gets it, so no fork outlives the workflow unrecorded. */
  async made(volume: string) { await this.host.storage.put(ROW + volume, { at: this.now() }); }

  /**
   * A fork the owner's result cache keeps (workflow-results.ts): a later workflow may get its child's result, fork and
   * all, and commit it. The end does not delete a pinned fork; the cache's release (`unpin`) gives it back to `ended`.
   * Issued synchronously (its storage write before any later read), so an end right after a landing sees the pin. Kept
   * apart from the forks this workflow made: only those are ever deleted, so a pin of any other volume deletes nothing.
   */
  pin(volume: string) { return this.host.storage.put(PIN + volume, { at: this.now() }); }
  /** The forks the result cache keeps, with when each was pinned. */
  async pinned() {
    return [...(await this.host.storage.list<{ at: number }>({ prefix: PIN }))].map(([key, row]) => ({ fork: key.slice(PIN.length), at: row.at }));
  }
  async unpin(volume: string) { await this.host.storage.delete(PIN + volume); }

  /** When the next try is due (an alarm the object keeps armed), or undefined when nothing waits. */
  async retryAt() { return (await this.host.storage.get<{ at: number }>(RETRY))?.at; }

  /**
   * The workflow ended: delete its forks. Answers when to try again (some delete failed, or a commit is still landing),
   * always in the future, or undefined when every fork is gone.
   */
  async ended(): Promise<number | undefined> {
    // Only forks this workflow made; one the result cache pins stays until it is released (unpin), then goes on the next pass.
    const pins = await this.host.storage.list({ prefix: PIN });
    const forks = [...(await this.host.storage.list({ prefix: ROW })).keys()].filter(key => !pins.has(PIN + key.slice(ROW.length)));
    if (!forks.length) { await this.host.storage.delete(RETRY); return undefined; }
    const committing = [...(await this.host.storage.list<{ kind?: string }>({ prefix: IN_FLIGHT })).values()].some(row => row.kind === "commit");
    let failed = committing;
    if (!committing) for (const key of forks) {
      try {
        await this.host.deleteFork(key.slice(ROW.length));
        await this.host.storage.delete(key);
      } catch (error) {
        failed = true;
        console.error(JSON.stringify({ type: "workflow_fork_delete_failed", fork: key.slice(ROW.length), error: error instanceof Error ? error.message.slice(0, 200) : "Error" }));
      }
    }
    if (!failed) { await this.host.storage.delete(RETRY); return undefined; }
    const tries = ((await this.host.storage.get<{ tries: number }>(RETRY))?.tries ?? 0) + 1;
    const at = this.now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (tries - 1));
    await this.host.storage.put(RETRY, { at, tries });
    return at;
  }
}
