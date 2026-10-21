import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI runs the suite in shards, one job each: `test-shard.ts 2/4` runs the second of four
 * under the job's AGENT_HOSTING. Files are dealt longest first to the shard with the least
 * time so far, by their seconds in tests/timings.json, so every shard gets the same files on
 * every runner and together they run each file once. A file the table does not know counts
 * as DEFAULT_SECONDS. `test-shard.ts --plan 6` prints every shard, for six shards a mode
 * (the default is five, as CI runs; `--plan 5 6` for six inline).
 *
 * Every shard also records each file's wall time as CI runs it (TEST_CONCURRENCY files at once) in
 * test-timings/<hosting>-<index>of<count>.json (scripts/test-timings-reporter.ts), kept as the run's
 * test-timings-* artifacts. To rebalance from green runs (a file's time is its mean over them):
 *   gh run download <run id> -p 'test-timings-*' -D /tmp/timings/<run id>   (for each run)
 *   npm run test:shard -- --update /tmp/timings/*
 * which rewrites the table with those times and drops files that no longer exist.
 *
 * A shard whose failures are in at most RETRY_FILES files runs those files once more, alone. If they pass then, the
 * shard passes, and each is reported as flaky (a ::warning:: annotation on the run, naming the file): fix it, as
 * docs/operations/README.md says. More failing files than that is a broken change, not a flake, and fails at once.
 */
const DEFAULT_SECONDS = 5;
const RETRY_FILES = 3;
// Per test file as well as per test: the longest cluster files (tests/cluster-fresh-lease-*) run past two minutes on a CI runner.
// Keep CI's file concurrency independent of the shared host's CPU count.
const TEST_ARGS = [
  "--experimental-strip-types", "--test-timeout=240000",
  ...(process.env.TEST_DATABASE_PER_FILE === "true" ? ["--import", "./scripts/test-worker-database.ts"] : []),
  fileURLToPath(new URL("test-files.ts", import.meta.url)),
];
const tests = new URL("../tests/", import.meta.url);
const timingsFile = new URL("timings.json", tests);
const files = readdirSync(tests).filter(name => name.endsWith(".test.ts")).sort();
// The simulator hosts its nodes inline whatever AGENT_HOSTING says (tests/sim/sim.ts), so its files would only
// run twice the same way: they run in the inline shards alone.
const inlineOnly = (file: string) => file.startsWith("sim-") || file === "sim.test.ts";
const filesFor = (hosting: string) => files.filter(file => hosting === "inline" || !inlineOnly(file));

function run(args: string[], timingsOut: string, failuresOut: string) {
  return spawnSync(process.execPath, [...TEST_ARGS, timingsOut, failuresOut, ...args], { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)) }).status ?? 1;
}

function* jsonFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* jsonFiles(join(dir, entry.name));
    else if (entry.name.endsWith(".json")) yield join(dir, entry.name);
  }
}

function shard(index: number, count: number, hosting: string, seconds: Record<string, number>) {
  const weight = (file: string) => seconds[file] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  for (const file of filesFor(hosting).sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, next) => next.seconds < best.seconds ? next : best);
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  return shards[index - 1];
}

if (process.argv[2] === "--update") {
  const dirs = process.argv.slice(3);
  if (!dirs.length) throw new Error("Usage: test-shard.ts --update <dir of test-timings JSON>...");
  const table = JSON.parse(readFileSync(timingsFile, "utf8")) as Record<string, Record<string, number>>;
  // A file's time is its mean over the runs given: a runner's speed and a shard's neighbours vary.
  const recorded: Record<string, Record<string, number[]>> = {};
  for (const path of dirs.flatMap(dir => [...jsonFiles(dir)])) {
    const hosting = path.match(/(process|inline)-\d+of\d+\.json$/)?.[1];
    if (!hosting) continue;
    for (const [file, seconds] of Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, number>)) ((recorded[hosting] ??= {})[file] ??= []).push(seconds);
  }
  for (const [hosting, files] of Object.entries(recorded)) for (const [file, times] of Object.entries(files)) {
    (table[hosting] ??= {})[file] = Math.round(times.reduce((sum, time) => sum + time, 0) / times.length * 10) / 10;
  }
  const sorted = Object.fromEntries(Object.entries(table).map(([hosting, seconds]) => [hosting,
    Object.fromEntries(Object.entries(seconds).filter(([file]) => filesFor(hosting).includes(file)).sort(([a], [b]) => a.localeCompare(b)))]));
  writeFileSync(timingsFile, `${JSON.stringify(sorted, null, 2)}\n`);
} else if (process.argv[2] === "--plan") {
  const counts: Record<string, number> = { process: Number(process.argv[3] ?? 5), inline: Number(process.argv[4] ?? process.argv[3] ?? 5) };
  for (const [hosting, seconds] of Object.entries(JSON.parse(readFileSync(timingsFile, "utf8")) as Record<string, Record<string, number>>)) {
    const count = counts[hosting];
    for (let index = 1; index <= count; index++) {
      const planned = shard(index, count, hosting, seconds);
      console.log(`${hosting} ${index}/${count}: ~${Math.round(planned.seconds)}s ${planned.files.join(" ")}`);
    }
  }
} else {
  const [index, count] = (process.argv[2]?.match(/^(\d+)\/(\d+)$/) ?? []).slice(1).map(Number);
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error("Usage: test-shard.ts <index>/<count> | --plan <process count> [<inline count>] | --update <dir>");
  const hosting = process.env.AGENT_HOSTING ?? "process";
  const planned = shard(index, count, hosting, JSON.parse(readFileSync(timingsFile, "utf8"))[hosting] ?? {});
  console.log(`# shard ${index}/${count} (${hosting}): ~${Math.round(planned.seconds)}s of ${planned.files.join(", ")}`);
  const timingsDir = fileURLToPath(new URL("../test-timings/", import.meta.url));
  mkdirSync(timingsDir, { recursive: true });
  const name = `${hosting}-${index}of${count}`;
  const failuresOut = join(timingsDir, `${name}.failed`);
  let status = run(planned.files.map(file => `tests/${file}`), join(timingsDir, `${name}.json`), failuresOut);
  const failed = status === 0 ? [] : readFileSync(failuresOut, "utf8").split("\n").filter(Boolean);
  if (failed.length > 0 && failed.length <= RETRY_FILES) {
    console.log(`# ${failed.join(", ")} failed; running ${failed.length === 1 ? "it" : "them"} once more, alone`);
    status = run(failed.map(file => `tests/${file}`), join(timingsDir, `${name}.retry`), join(timingsDir, `${name}.retry-failed`));
    if (status === 0) for (const file of failed) console.log(`::warning title=Flaky test file::${file} failed under ${hosting} hosting (shard ${index}/${count}), then passed alone`);
  }
  process.exitCode = status;
}
