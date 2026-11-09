/** Reconstructed from durable messages and the request, available for the run's retention. */
export function runLog(run: Record<string, any>, history: { messages: unknown[] }) {
  const events = history.messages.map((message, index) => {
    const value = message as Record<string, any>;
    return { index, type: "message", at: value.timestamp ?? null, message };
  });
  return { run, durationMs: typeof run.startedAt === "number" && typeof run.endedAt === "number" ? run.endedAt - run.startedAt : null, events };
}
