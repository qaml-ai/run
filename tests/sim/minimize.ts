import type { Plan } from "./workload.ts";

/** What a failure is, for minimizing: its kind (I3, I8, assertion...), so a smaller plan fails the same way. */
export const signature = (failure: string) => failure.split(":", 1)[0];

/**
 * A smaller plan that still fails as `plan` does: delta debugging (ddmin) over its steps, keeping a cut when the run
 * still has a failure of one of the original kinds. The seed (and so every other draw) stays as it is. `run` runs a
 * plan and returns its failures.
 */
export async function minimize(plan: Plan, run: (plan: Plan) => Promise<string[]>, log: (line: string) => void = () => {}) {
  const kinds = new Set((await run(plan)).map(signature));
  if (!kinds.size) throw new Error("The plan does not fail");
  const fails = async (steps: Plan["steps"]) => (await run({ ...plan, steps })).some(failure => kinds.has(signature(failure)));
  let steps = plan.steps;
  for (let parts = 2; steps.length >= 2;) {
    const size = Math.ceil(steps.length / parts);
    let cut = false;
    for (let start = 0; start < steps.length; start += size) {
      const candidate = [...steps.slice(0, start), ...steps.slice(start + size)];
      if (await fails(candidate)) {
        steps = candidate;
        parts = Math.max(parts - 1, 2);
        cut = true;
        log(`${steps.length} steps still fail`);
        break;
      }
    }
    if (!cut) {
      if (parts >= steps.length) break;
      parts = Math.min(parts * 2, steps.length);
    }
  }
  return { ...plan, steps };
}
