import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI runs the suite in shards, one job each: `test-shard.ts 2/4` runs the second of four
 * under the job's AGENT_HOSTING. Files are dealt longest first to the shard with the least
 * time so far, by their seconds in tests/timings.json, so every shard gets the same files on
 * every runner and together they run each file once. A file the table does not know counts
 * as DEFAULT_SECONDS. `test-shard.ts --plan 4` prints every shard.
 *
 * Every shard also records each file's wall time, as CI runs it (several files at once), in
 * test-timings/<hosting>-<index>of<count>.json (scripts/test-timings-reporter.ts); CI keeps
 * them as the run's test-timings-* artifacts. To rebalance from a green run:
 *   gh run download <run id> -p 'test-timings-*' -D /tmp/timings && npm run test:shard -- --update /tmp/timings
 * which rewrites the table with those times and drops files that no longer exist.
 */
const DEFAULT_SECONDS = 5;
// Per test file as well as per test: the longest cluster files (tests/cluster-fresh-lease-*) run past two minutes on a CI runner.
const TEST_ARGS = ["--experimental-strip-types", "--test", "--test-timeout=240000"];
const tests = new URL("../tests/", import.meta.url);
const timingsFile = new URL("timings.json", tests);
const files = readdirSync(tests).filter(name => name.endsWith(".test.ts")).sort();

function run(args: string[], timingsOut: string) {
  const reporters = [
    `--test-reporter=${process.stdout.isTTY ? "spec" : "tap"}`, "--test-reporter-destination=stdout",
    `--test-reporter=${fileURLToPath(new URL("test-timings-reporter.ts", import.meta.url))}`, `--test-reporter-destination=${timingsOut}`,
  ];
  return spawnSync(process.execPath, [...TEST_ARGS, ...reporters, ...args], { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)) }).status ?? 1;
}

function* jsonFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* jsonFiles(join(dir, entry.name));
    else if (entry.name.endsWith(".json")) yield join(dir, entry.name);
  }
}

function shard(index: number, count: number, seconds: Record<string, number>) {
  const weight = (file: string) => seconds[file] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, next) => next.seconds < best.seconds ? next : best);
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards[index - 1];
}

if (process.argv[2] === "--update") {
  const dir = process.argv[3];
  if (!dir) throw new Error("Usage: test-shard.ts --update <dir of test-timings JSON>");
  const table = JSON.parse(readFileSync(timingsFile, "utf8")) as Record<string, Record<string, number>>;
  for (const path of jsonFiles(dir)) {
    const hosting = path.match(/(process|inline)-\d+of\d+\.json$/)?.[1];
    if (!hosting) continue;
    Object.assign(table[hosting] ??= {}, JSON.parse(readFileSync(path, "utf8")));
  }
  for (const seconds of Object.values(table)) {
    for (const file of Object.keys(seconds)) if (!files.includes(file)) delete seconds[file];
  }
  const sorted = Object.fromEntries(Object.entries(table).map(([hosting, seconds]) => [hosting, Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => a.localeCompare(b)))]));
  writeFileSync(timingsFile, `${JSON.stringify(sorted, null, 2)}\n`);
} else if (process.argv[2] === "--plan") {
  const count = Number(process.argv[3] ?? 4);
  for (const [hosting, seconds] of Object.entries(JSON.parse(readFileSync(timingsFile, "utf8")) as Record<string, Record<string, number>>)) {
    for (let index = 1; index <= count; index++) {
      const planned = shard(index, count, seconds);
      console.log(`${hosting} ${index}/${count}: ~${Math.round(planned.seconds)}s ${planned.files.join(" ")}`);
    }
  }
} else {
  const [index, count] = (process.argv[2]?.match(/^(\d+)\/(\d+)$/) ?? []).slice(1).map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error("Usage: test-shard.ts <index>/<count> | --plan <count> | --update <dir>");
  const hosting = process.env.AGENT_HOSTING ?? "process";
  const planned = shard(index, count, JSON.parse(readFileSync(timingsFile, "utf8"))[hosting] ?? {});
  console.log(`# shard ${index}/${count} (${hosting}): ~${Math.round(planned.seconds)}s of ${planned.files.join(", ")}`);
  const timingsDir = fileURLToPath(new URL("../test-timings/", import.meta.url));
  mkdirSync(timingsDir, { recursive: true });
  process.exitCode = run(planned.files.map(file => `tests/${file}`), join(timingsDir, `${hosting}-${index}of${count}.json`));
}
