const workers = new Map<number, () => Promise<void>>();
const fixtures = new Set<() => Promise<void>>();
let shuttingDown = false;

export function checkFixtureLifecycle() {
  if (shuttingDown) throw new Error("Local Worker startup was cancelled");
}

export function registerWorker(pid: number, stop: () => Promise<void>) {
  workers.set(pid, stop);
  return () => { workers.delete(pid); };
}

export function registerFixture(stop: () => Promise<void>) {
  fixtures.add(stop);
  return () => { fixtures.delete(stop); };
}

async function stopAll() {
  // Stop the processes even if a fixture is still starting or cleaning up.
  const results = await Promise.allSettled([...workers.values(), ...fixtures].map(stop => stop()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Local Worker file cleanup failed");
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void stopAll().catch(error => console.error(error)).finally(() => process.exit(code));
  });
}
process.on("exit", () => {
  for (const pid of workers.keys()) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
});
