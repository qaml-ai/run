import { relative } from "node:path";
import type { TestContext } from "node:test";
import fc from "fast-check";

/**
 * Shared settings for the property tests (`tests/prop-*.test.ts`, fast-check).
 *
 * - Each property names its own run count for a pull request (`runs`), kept small so all of them add under a minute.
 * - `PROP_SCALE` multiplies every count: the nightly workflow sets it (e.g. 100) to search much deeper.
 * - `PROP_SEED` (and `PROP_PATH`) replay one failure: fast-check prints both, and `check` adds the command to rerun it.
 *   A seed alone reruns the same generation; with the path it jumps straight to the shrunk counterexample.
 */
const SCALE = Number(process.env.PROP_SCALE || 1);
if (!Number.isFinite(SCALE) || SCALE <= 0) throw new Error("PROP_SCALE must be a positive number");
const SEED = process.env.PROP_SEED ? Number(process.env.PROP_SEED) : undefined;
if (SEED !== undefined && !Number.isInteger(SEED)) throw new Error("PROP_SEED must be an integer");
const PATH = process.env.PROP_PATH || undefined;

/** How many runs a property gets here: its pull-request count, scaled for the nightly search. */
export const runsFor = (runs: number) => Math.max(1, Math.round(runs * SCALE));

/**
 * Check `property` for `runs` runs (times PROP_SCALE). The seed is chosen here and always reported on failure, with
 * fast-check's path, its shrunk counterexample, and the command that replays exactly that case.
 */
export async function check<Ts>(t: TestContext, property: fc.IProperty<Ts> | fc.IAsyncProperty<Ts>, options: { runs: number } & Omit<fc.Parameters<Ts>, "numRuns" | "seed" | "path">) {
  const { runs, ...rest } = options;
  const seed = SEED ?? (Date.now() ^ Math.floor(Math.random() * 0x100000000)) | 0;
  const parameters: fc.Parameters<Ts> = { ...rest, numRuns: runsFor(runs), seed, ...(PATH !== undefined && SEED !== undefined ? { path: PATH, endOnFailure: true } : {}) };
  // A synchronous property's details come back as they are, an asynchronous one's as a promise: awaited either way.
  const details = await (fc.check(property as fc.IAsyncProperty<Ts>, parameters) as Promise<fc.RunDetails<Ts>> | fc.RunDetails<Ts>);
  if (!details.failed) return;
  // TestContext.filePath (Node 22.6+) is not in the @types/node this repo pins.
  const path = (t as { filePath?: string }).filePath;
  const file = path ? relative(process.cwd(), path) : "tests/prop-*.test.ts";
  const replay = `PROP_SEED=${details.seed} PROP_PATH=${details.counterexamplePath ?? ""} node --experimental-strip-types --test --test-name-pattern='${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("'", "'\\''")}' ${file}`;
  const report = fc.defaultReportMessage(details) ?? "Property failed";
  const cause = details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance);
  throw new Error(`${report}\n\nFailure: ${cause}\n\nReplay: ${replay}`);
}

export { fc };
