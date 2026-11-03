// An agent host (src/agent-child.ts) that misbehaves when its supervisor asks, as a host with a bug could: "spin" keeps
// its thread busy for good, "grow" allocates until its heap gives out, "crash" throws outside any request. The rest is the
// real host. AgentSupervisor's `entry` option starts it, in a process or a thread.
import { parentPort } from "node:worker_threads";

const kept: unknown[] = [];
const faults: Record<string, () => void> = {
  spin: () => { for (;;); },
  grow: () => { for (;;) kept.push(Array.from({ length: 100_000 }, (_, i) => ({ i }))); },
  crash: () => { setImmediate(() => { throw new Error("The host crashed"); }); },
};
// Heard before the host's own handler, which then refuses the method it does not know (if it gets to).
const heard = (message: unknown) => {
  const request = (typeof message === "string" ? JSON.parse(message) : message) as { type?: string; method?: string };
  if (request.type === "request" && request.method && Object.hasOwn(faults, request.method)) faults[request.method]();
};
if (parentPort) parentPort.on("message", heard);
else process.on("message", heard);

await import("../../src/agent-child.ts");
