const ROW = "workflow-repo:";
const RETRY = "workflow-repo-retry";
/** Kept while a commit() is in flight (WorkflowJobs' rows): its fork must outlive it. */
const IN_FLIGHT = "workflow-job:";
const FIRST_RETRY_MS = 60_000, MAX_RETRY_MS = 3_600_000;

export interface BranchJanitorHost {
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
  deleteOwned(repo: string): Promise<{ held: string[] }>;
  now?: () => number;
}

export class BranchJanitor {
  private readonly host: BranchJanitorHost;
  constructor(host: BranchJanitorHost) { this.host = host; }
  private now() { return (this.host.now ?? Date.now)(); }

  /** When the next try is due (an alarm the object keeps armed), or undefined when nothing waits. */
  async retryAt() { return (await this.host.storage.get<{ at: number }>(RETRY))?.at; }

  /**
   * The workflow ended: delete its forks. Answers when to try again (some delete failed, or a commit is still landing),
   * always in the future, or undefined when every fork is gone.
   */
  async ended(): Promise<number | undefined> {
    const forks = [...(await this.host.storage.list({ prefix: ROW })).keys()];
    if (!forks.length) { await this.host.storage.delete(RETRY); return undefined; }
    const committing = [...(await this.host.storage.list<{ kind?: string }>({ prefix: IN_FLIGHT })).values()].some(row => row.kind === "commit");
    let failed = committing;
    if (!committing) for (const key of forks) {
      try {
        if ((await this.host.deleteOwned(key.slice(ROW.length))).held.length) { failed = true; continue; }
        await this.host.storage.delete(key);
      } catch (error) {
        failed = true;
        console.error(JSON.stringify({ type: "workflow_ref_delete_failed", fork: key.slice(ROW.length), error: error instanceof Error ? error.message.slice(0, 200) : "Error" }));
      }
    }
    if (!failed) { await this.host.storage.delete(RETRY); return undefined; }
    const tries = ((await this.host.storage.get<{ tries: number }>(RETRY))?.tries ?? 0) + 1;
    const at = this.now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (tries - 1));
    await this.host.storage.put(RETRY, { at, tries });
    return at;
  }
}
