import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";

/** One sandbox DO per session; admission is held until the remote VM has stopped. */
export function isolatedSandboxRemote(options: {
  agentKey: string;
  getByName: (key: string) => CodemodeRemote;
  maxConcurrent?: number;
}): () => CodemodeRemote {
  const limit = options.maxConcurrent ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3)
    throw new Error("Invalid sandbox concurrency limit");
  // This in-memory guard resets with its owner. It is not a durable quota on
  // remote work that may outlive a caller reset or its own wall-time deadline.
  let active = 0;
  return () => ({
    async execute(request, exchange) {
      // Refuse excess work rather than building an unbounded in-memory queue
      // outside Pi's journal. The stock bridge returns this as a sandbox error.
      if (active >= limit)
        throw new Error(`Agent sandbox concurrency limit (${limit}) reached`);
      active++;
      try {
        // The session's executions share one isolate. Each RPC still owns an
        // independent VM; the remote subclass also enforces this cap.
        await options.getByName(options.agentKey).execute(request, exchange);
        // A caller deadline is not proof that the remote stopped. Keep the slot
        // until RPC completion/rejection; otherwise timeouts admit more live VMs.
      } finally {
        active--;
      }
    },
  });
}
