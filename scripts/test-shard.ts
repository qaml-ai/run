import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * CI runs the suite in shards, one job each: `test-shard.ts 2/4` runs the second of four
 * under the job's AGENT_HOSTING. Files are dealt longest first to the shard with the least
 * time so far, by their seconds in tests/timings.json, so every shard gets the same files on
 * every runner and together they run each file once. A file the table does not know counts
 * as DEFAULT_SECONDS. `test-shard.ts --plan 4` prints every shard; `test-shard.ts --measure`
 * runs each file alone in both hosting modes and rewrites the table (only the ratios matter,
 * so any machine will do).
 */
const DEFAULT_SECONDS = 5;
// Per test file as well as per test: the longest cluster files (tests/cluster-fresh-lease-*) run past two minutes on a CI runner.
const TEST_ARGS = ["--experimental-strip-types", "--test", "--test-timeout=240000"];
const tests = new URL("../tests/", import.meta.url);
const timingsFile = new URL("timings.json", tests);
const files = readdirSync(tests).filter(name => name.endsWith(".test.ts")).sort();

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [...TEST_ARGS, ...args], { stdio: "inherit", env, cwd: fileURLToPath(new URL("..", import.meta.url)) }).status ?? 1;
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

if (process.argv[2] === "--measure") {
  const table: Record<string, Record<string, number>> = { process: {}, inline: {} };
  for (const hosting of Object.keys(table)) for (const file of files) {
    const started = performance.now();
    if (run([`tests/${file}`], { ...process.env, AGENT_HOSTING: hosting }) !== 0) throw new Error(`${file} failed under ${hosting} hosting`);
    table[hosting][file] = Math.round((performance.now() - started) / 100) / 10;
  }
  writeFileSync(timingsFile, `${JSON.stringify(table, null, 2)}\n`);
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
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error("Usage: test-shard.ts <index>/<count> | --plan <count> | --measure");
  const hosting = process.env.AGENT_HOSTING ?? "process";
  const planned = shard(index, count, JSON.parse(readFileSync(timingsFile, "utf8"))[hosting] ?? {});
  console.log(`# shard ${index}/${count} (${hosting}): ~${Math.round(planned.seconds)}s of ${planned.files.join(", ")}`);
  process.exitCode = run(planned.files.map(file => `tests/${file}`));
}
