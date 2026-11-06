import { readFileSync } from "node:fs";

type DurationRow = { area: string; source: string; name: string; status: string; durationMs?: number; durationSamplesMs?: number[] };
let durations: Map<string, number> | undefined;
const key = (area: string, source: string, name: string) => `${area}\0${source}\0${name}`;

/** A missing observation retains the old budget. Explicit case timeouts bypass this helper. */
export function caseTimeout(area: string, source: string, name: string): number {
  if (process.env.CONTRACT_TIMEOUT_MS !== undefined) {
    const value = Number(process.env.CONTRACT_TIMEOUT_MS);
    if (!Number.isFinite(value) || value <= 0) throw new Error("CONTRACT_TIMEOUT_MS must be positive");
    return value;
  }
  if (process.env.CONTRACT_BACKEND !== "workers" || !process.env.CONTRACT_NODE_BASELINE) return 90_000;
  if (!durations) {
    const report = JSON.parse(readFileSync(process.env.CONTRACT_NODE_BASELINE, "utf8")) as { rows: DurationRow[] };
    durations = new Map();
    for (const row of report.rows) {
      if (row.status !== "pass") continue;
      const samples = (row.durationSamplesMs ?? [row.durationMs]).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0).sort((a, b) => a - b);
      if (samples.length) durations.set(key(row.area, row.source, row.name), samples[Math.ceil(samples.length * 0.99) - 1]);
    }
  }
  const observed = durations.get(key(area, source, name));
  // The Node baseline's p99 is about 23 seconds. Measured concurrent Wrangler
  // startup exhausted a 10-second floor before reaching assertions. Include
  // that setup in a 30-second floor; slow cases keep three times their Node p99.
  // Channel cases start their services' fakes (and a DNS stand-in for email) beside the fixture, and a file's first case
  // also waits out a cold Wrangler build on its Sprite: 30 s was measured too short for that (2 of 70 cases), 60 s is not.
  return observed === undefined ? 90_000 : Math.max(area === "channels" ? 60_000 : 30_000, Math.ceil(observed * 3));
}
