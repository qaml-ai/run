import type { CodemodeRemote } from "@earendil-works/pi-codemode/portable";

/** One stateless sandbox DO per execution, with admission shared by one agent incarnation. */
export function isolatedSandboxRemote(options: {
  agentKey: string;
  getByName: (key: string) => CodemodeRemote;
  maxConcurrent?: number;
  executionId?: () => string;
}): () => CodemodeRemote {
  const limit = options.maxConcurrent ?? 4;
  if (!Number.isInteger(limit) || limit < 1 || limit > 16)
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
        // Resolve once, before launching. Every callback and the terminal reply
        // belong to this execution's RPC; replay creates another stateless VM.
        const key = `${options.agentKey}:execution:${(options.executionId ?? (() => crypto.randomUUID()))()}`;
        await options.getByName(key).execute(request, exchange);
        // A caller deadline is not proof that the remote stopped. Keep the slot
        // until RPC completion/rejection; otherwise timeouts admit more live VMs.
      } finally {
        active--;
      }
    },
  });
}
