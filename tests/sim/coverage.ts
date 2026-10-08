import { Session } from "node:inspector/promises";
import { fileURLToPath } from "node:url";

type Range = { startOffset: number; endOffset: number; count: number };
type ScriptCoverage = { url: string; functions: { ranges: Range[] }[] };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COVERED = [`${ROOT}src/`, `${ROOT}shared/`];

/** A 32-bit FNV-1a hash, for features: what is kept and compared is numbers, not strings. */
export function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193);
  return value >>> 0;
}

/**
 * V8's precise block coverage of the runtime's own code (src/ and shared/), read in this process through the inspector,
 * one run at a time: `take` answers the blocks the run executed since the last take, as features (a hash of the file
 * and the block). How often a block ran is left out: counts differ from run to run for no new behaviour (timers, retries)
 * and would keep nearly every run.
 *
 * V8 lists a block only where its count differs from the range around it, so a block seen once as never run
 * (count 0) and later run as often as its function is no longer listed at all. So every block ever listed is kept
 * (`known`), and each run's count for it is the innermost range of that run that holds it.
 */
export class Coverage {
  private readonly session = new Session();
  private readonly known = new Map<string, Map<string, [number, number]>>();

  async start() {
    this.session.connect();
    await this.session.post("Profiler.enable");
    await this.session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    // What ran before the first run (loading, migrations) is not a run's.
    await this.session.post("Profiler.takePreciseCoverage");
  }

  /** The features of what ran since the last take (counts start over at each take). */
  async take(): Promise<Set<number>> {
    const { result } = await this.session.post("Profiler.takePreciseCoverage") as { result: ScriptCoverage[] };
    const features = new Set<number>();
    for (const script of result) {
      const path = script.url.startsWith("file://") ? fileURLToPath(script.url) : script.url;
      if (!COVERED.some(prefix => path.startsWith(prefix))) continue;
      const file = path.slice(ROOT.length);
      let known = this.known.get(file);
      if (!known) this.known.set(file, known = new Map());
      const ranges: Range[] = [];
      for (const fn of script.functions) for (const range of fn.ranges) {
        ranges.push(range);
        const key = `${range.startOffset}:${range.endOffset}`;
        if (!known.has(key)) known.set(key, [range.startOffset, range.endOffset]);
      }
      // V8's ranges nest. In order of start (the outer first), a stack holds the ranges around a position; the
      // innermost of them that reaches past a block's end holds it, and decides its count.
      ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const blocks = [...known].sort(([, a], [, b]) => a[0] - b[0] || b[1] - a[1]);
      const stack: Range[] = [];
      let next = 0;
      for (const [key, [start, end]] of blocks) {
        for (; next < ranges.length && ranges[next].startOffset <= start; next++) {
          while (stack.length && stack.at(-1)!.endOffset <= ranges[next].startOffset) stack.pop();
          stack.push(ranges[next]);
        }
        let holder: Range | undefined;
        for (let index = stack.length - 1; index >= 0; index--) if (stack[index].endOffset >= end) { holder = stack[index]; break; }
        if (holder && holder.count > 0) features.add(hash(`${file}:${key}`));
      }
    }
    return features;
  }

  /** How many blocks of the runtime's code are known so far (the denominator for coverage reports, roughly). */
  get blocks() { let total = 0; for (const known of this.known.values()) total += known.size; return total; }

  async stop() {
    await this.session.post("Profiler.stopPreciseCoverage").catch(() => {});
    this.session.disconnect();
  }
}
