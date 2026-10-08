import { fork, type ChildProcess } from "node:child_process";

export const QUERY_LIMITS = { rows: 1_000, ms: 2_000 };
export type QueryResult = { columns: string[]; rows: unknown[][] };

/**
 * The sample dataset (sample.sql), read-only. Queries run one at a time in a child process, and one that takes longer
 * than QUERY_LIMITS.ms kills it (the next query starts a fresh one), so no query can hold up the app.
 */
export class SampleDb {
  private child?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;

  query(sql: string): Promise<QueryResult> {
    const result = this.queue.then(() => this.run(sql));
    this.queue = result.catch(() => {});
    return result;
  }

  close() { this.child?.kill(); this.child = undefined; }

  private run(sql: string): Promise<QueryResult> {
    const child = this.child ??= fork(new URL("./query-process.ts", import.meta.url), [String(QUERY_LIMITS.rows)], {
      execArgv: [...process.execArgv, "--disable-warning=ExperimentalWarning"], stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.child = undefined;
        child.kill("SIGKILL");
        reject(new Error(`Took longer than ${QUERY_LIMITS.ms / 1000} s`));
      }, QUERY_LIMITS.ms);
      const onMessage = (message: { id: number; error?: string } & QueryResult) => {
        if (message.id !== id) return;
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve({ columns: message.columns, rows: message.rows });
      };
      const onExit = () => { cleanup(); this.child = undefined; reject(new Error("The query process ended")); };
      const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.send({ id, sql });
    });
  }
}
