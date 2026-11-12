/** Each Postgres read that must run inside startup (Pi's open) gets this long; two of them stay well under the 30 s reset. */
export const START_STEP_DEADLINE_MS = 4_000;
/**
 * A startup step with a deadline: past it the start fails at once (agent_start_deadline), and the object starts again on
 * its next wake, rather than waiting into Workers' 30 s reset (which every later wake would repeat while the cause lasts).
 */
export function startDeadline<T>(step: string, work: Promise<T>, ms = START_STEP_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    console.error(JSON.stringify({ type: "agent_start_deadline", step, ms }));
    reject(Object.assign(new Error(`Agent startup: ${step} took over ${ms} ms; it starts again on its next wake`), { status: 503 }));
  }, ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
