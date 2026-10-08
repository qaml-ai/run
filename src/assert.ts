/**
 * Assertions a simulation checks, after Antithesis's: `always` (true every time it is reached), `sometimes` (true at least
 * once over the runs: proof the state was exercised), `reachable` (reached at least once) and `unreachable` (never
 * reached). A simulator records every call (`installAssertions`). In production `sometimes` and `reachable` do nothing,
 * and a failed `always` or a reached `unreachable` logs one line the first time each message fails in the process
 * (`{"type":"assert",...}`), so the same catalogue can be read from real runs. Messages are constant strings; nothing
 * is allocated unless an assertion fails.
 */
export type Assertions = {
  always(condition: boolean, message: string): void;
  sometimes(condition: boolean, message: string): void;
  reachable(message: string): void;
  unreachable(message: string): void;
};

let recorder: Assertions | undefined;
/** Messages already logged as failed in this process: one line each. */
const failed = new Set<string>();

function report(kind: "always" | "unreachable", message: string) {
  if (failed.has(message)) return;
  failed.add(message);
  console.error(JSON.stringify({ type: "assert", kind, assertion: message }));
}

/** `condition` holds every time this is reached. */
export function always(condition: boolean, message: string) {
  if (recorder) recorder.always(condition, message);
  else if (!condition) report("always", message);
}

/** `condition` holds at least once, over all runs. */
export function sometimes(condition: boolean, message: string) {
  if (recorder) recorder.sometimes(condition, message);
}

/** This is reached at least once, over all runs. */
export function reachable(message: string) {
  if (recorder) recorder.reachable(message);
}

/** This is never reached. */
export function unreachable(message: string) {
  if (recorder) recorder.unreachable(message);
  else report("unreachable", message);
}

/** For a simulator: record every assertion (undefined: back to production's behaviour). Process-wide. */
export function installAssertions(next: Assertions | undefined) {
  recorder = next;
}
