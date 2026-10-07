import { readdirSync, readFileSync } from "node:fs";
import { installAssertions } from "../../src/assert.ts";
import { installBuggify } from "../../src/buggify.ts";
import { prng } from "./env.ts";

const SOURCES = ["../../src/", "../../shared/"].map(dir => new URL(dir, import.meta.url));

/** Every literal in `src/` and `shared/` that a call of `name` takes as its site or message. */
function catalogue(pattern: RegExp) {
  const found = new Set<string>();
  for (const dir of SOURCES) {
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts"))) {
      for (const match of readFileSync(new URL(file, dir), "utf8").matchAll(pattern)) found.add(match[1]);
    }
  }
  return [...found].sort();
}
/** The BUGGIFY sites compiled into the runtime. */
export const BUGGIFY_SITES = catalogue(/\bbuggify\("([^"]+)"/g);
/** The `sometimes` and `reachable` assertions: each should be hit by some run, which proves the state was exercised. */
export const COVERAGE_GOALS = catalogue(/\b(?:sometimes\([^;]*?|reachable\()"([^"]+)"\)/g);

/** Which BUGGIFY sites fire, and how often: none, chosen ones, or a random subset at random rates (swarm, as FDB does). */
export type BuggifyPlan = false | Record<string, number> | "swarm";

/** One assertion's record over a run. */
export type Checked = { kind: "always" | "sometimes" | "reachable" | "unreachable"; hits: number; held: number };

/**
 * The simulation's side of src/buggify.ts and src/assert.ts, for one run: it decides each BUGGIFY site from its own
 * seeded stream (so the code that asks is no matter), and records every assertion. `violations` are an `always` that
 * failed or an `unreachable` reached.
 */
export class SimHooks {
  /** Each site's probability, for the sites this run enables. */
  readonly plan: Record<string, number>;
  readonly fired = new Map<string, number>();
  /** Each time a site fired: when (virtual ms since the start, by the base clock) and for which node (by its clock's name). */
  readonly firings: { site: string; at: number; node?: string }[] = [];
  /** Set by the simulation: who is asking, for `firings`. */
  where: () => { at: number; node?: string } = () => ({ at: 0 });
  readonly checked = new Map<string, Checked>();
  readonly violations: string[] = [];

  constructor(seed: string, plan: BuggifyPlan) {
    const random = prng(`${seed}:buggify`);
    this.plan = plan === false ? {} : plan === "swarm"
      ? Object.fromEntries(BUGGIFY_SITES.filter(() => random.float() < 0.5).map(site => [site, [0.01, 0.05, 0.25][random.int(3)]]))
      : plan;
    installBuggify((site, probability) => {
      const rate = this.plan[site];
      if (rate === undefined || !(random.float() < (probability ?? rate))) return false;
      this.fired.set(site, (this.fired.get(site) ?? 0) + 1);
      this.firings.push({ site, ...this.where() });
      return true;
    });
    const record = (kind: Checked["kind"], message: string, held: boolean) => {
      const entry = this.checked.get(message) ?? { kind, hits: 0, held: 0 };
      entry.hits++;
      if (held) entry.held++;
      this.checked.set(message, entry);
      if ((kind === "always" && !held) || kind === "unreachable") this.violations.push(`${kind}: ${message}`);
    };
    installAssertions({
      always: (condition, message) => record("always", message, condition),
      sometimes: (condition, message) => record("sometimes", message, condition),
      reachable: message => record("reachable", message, true),
      unreachable: message => record("unreachable", message, true),
    });
  }

  /** The coverage goals this run reached: a `sometimes` that held at least once, a `reachable` reached. */
  get reached() { return [...this.checked].filter(([, entry]) => (entry.kind === "sometimes" || entry.kind === "reachable") && entry.held > 0).map(([message]) => message).sort(); }

  uninstall() {
    installBuggify(undefined);
    installAssertions(undefined);
  }
}
