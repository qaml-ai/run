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
 * - `PROP_REPLAY_PATH` completes the path for a sequence of commands (`replayableCommands` below), whose shrinking fast-check
 *   records apart from the path. The printed command sets it, and PROP_SCALE, whenever they matter.
 */
const SCALE = Number(process.env.PROP_SCALE || 1);
if (!Number.isFinite(SCALE) || SCALE <= 0) throw new Error("PROP_SCALE must be a positive number");
const SEED = process.env.PROP_SEED ? Number(process.env.PROP_SEED) : undefined;
if (SEED !== undefined && !Number.isInteger(SEED)) throw new Error("PROP_SEED must be an integer");
const PATH = process.env.PROP_PATH || undefined;
const REPLAY_PATH = process.env.PROP_REPLAY_PATH || undefined;

/** `fc.commands`, replayable: a property built on commands uses this, so the printed replay command reaches its shrunk case. */
export function replayableCommands<Model extends object, Real>(arbitraries: fc.Arbitrary<fc.AsyncCommand<Model, Real>>[], constraints: Omit<fc.CommandsContraints, "replayPath"> = {}) {
  return fc.commands(arbitraries, { ...constraints, ...(REPLAY_PATH !== undefined ? { replayPath: REPLAY_PATH } : {}) });
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

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
  // A sequence of commands prints its own replay path inside the counterexample.
  const replayPath = /\/\*replayPath="([^"]*)"\*\//.exec(fc.stringify(details.counterexample))?.[1];
  const env = [`PROP_SEED=${details.seed}`, `PROP_PATH=${details.counterexamplePath ?? ""}`, ...(replayPath ? [`PROP_REPLAY_PATH=${quote(replayPath)}`] : []), ...(SCALE !== 1 ? [`PROP_SCALE=${SCALE}`] : [])];
  const replay = `${env.join(" ")} node --experimental-strip-types --test --test-name-pattern=${quote(t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))} ${file}`;
  const report = fc.defaultReportMessage(details) ?? "Property failed";
  const cause = details.errorInstance instanceof Error ? details.errorInstance.message : String(details.errorInstance);
  throw new Error(`${report}\n\nFailure: ${cause}\n\nReplay: ${replay}`);
}

export { fc };

/** Wait for every task the event loop has, including I/O callbacks, `turns` times over. */
export async function turns(count = 3) { for (let index = 0; index < count; index++) await new Promise(resolve => setImmediate(resolve)); }
