import type { ChildProcess } from "node:child_process";

/** The exit event may precede the last stderr chunk. Diagnose only after close. */
export function observeWorkerExit(child: Pick<ChildProcess, "once">, output: () => string): Promise<Error> {
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  return new Promise(resolve => {
    child.once("close", (code, signal) => {
      const detail = spawnError ? `; ${spawnError.message}` : "";
      resolve(new Error(`workerd exited (code=${code ?? "null"}, signal=${signal ?? "none"}${detail}): ${output()}`,
        spawnError ? { cause: spawnError } : undefined));
    });
  });
}
