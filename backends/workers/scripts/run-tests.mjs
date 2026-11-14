// Run a Workers test suite with real file-level concurrency.
//   node scripts/run-tests.mjs unit|integration [--concurrency=N] [--test-shard=I/N] [node --test options...]
//
// Every file is isolated: each opens its own database (a copy of a migrated template database), picks its own
// ports and keeps its Wrangler state in its own temporary directory. Files therefore run side by side, except
// the few listed in `quiet`, which run by themselves once the rest are done.
//
// Unit files are mostly waiting on timers and short database connections, so they run one per CPU. An
// integration fixture is a local Wrangler plus workerd that bundles and boots for several CPU-seconds and holds
// hundreds of MB. Its tests have real deadlines (a 15 s run, a 7 s restart) and some races only show when the
// machine is starved: on an 8-vCPU Sprite, 4 fixtures at once failed about 1 run in 3, 2 at once never did. So
// each gets four CPUs and 2 GB, and a suite that needs to be faster is sharded over machines instead
// (`--test-shard=1/3`; scripts/sprite-test can start one command per shard).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suites = {
  unit: {
    loader: "./test/sdk-deps.mjs", suffix: ".test.ts", cpus: 1, least: 1, memory: 0,
    // Files that fail when the machine is busy, not because they share anything with another file. Each runs
    // concurrency inside one test, with a retry budget that CPU starvation exhausts.
    quiet: [
      // Eight concurrent adds; a transaction that loses a deadlock race is rerun twice (postgres-policy.ts).
      // Failed 4 of 15 full runs with 4 to 8 files at once, 5 of 72 runs of the file alone, 1 of 41 on the
      // unchanged serial tree: the race is in src/, running it last only keeps the machine from making it likelier.
      "test/billing-alerts.test.ts",
    ],
  },
  // A file that takes far longer than the rest can be given a `weight` (its share of a shard; 1 by default).
  integration: {
    loader: "./test/compat-register.mjs", suffix: ".integration.ts", cpus: 4, least: 2, memory: 2 * 1024 ** 3,
    // This measurement runs 65 DOs in one isolate. Other workerd fixtures skew its
    // startup/completion timings and memory sampling, so measure it on its own.
    quiet: ["test/delegation-load.integration.ts"],
  },
};
const [name, ...rest] = process.argv.slice(2);
const suite = suites[name];
if (!suite) {
  console.error("usage: run-tests.mjs unit|integration [--concurrency=N] [--test-shard=I/N] [node --test options]");
  process.exit(2);
}
let concurrency, shard;
const options = [], selected = [];
for (const argument of rest) {
  const count = /^--concurrency=(\d+)$/.exec(argument);
  const part = /^--test-shard=(\d+)\/(\d+)$/.exec(argument);
  if (count) concurrency = Number(count[1]);
  else if (part) shard = { index: Number(part[1]), total: Number(part[2]) };
  else if (/^test\/[^/]+\.ts$/.test(argument)) selected.push(argument);
  else options.push(argument);
}
if (shard && !(shard.index >= 1 && shard.index <= shard.total)) {
  console.error("--test-shard=I/N needs 1 <= I <= N");
  process.exit(2);
}
concurrency ??= Math.max(
  suite.least,
  Math.min(8, Math.floor(availableParallelism() / suite.cpus), suite.memory ? Math.floor(totalmem() / suite.memory) : Infinity),
);
const available = readdirSync(join(root, "test")).sort().map(file => `test/${file}`);
const integrationFile = file => file.endsWith(".integration.ts") || /^test\/voice-calls(?:-elevenlabs)?\.test\.ts$/.test(file);
let files = available.filter(file => name === "integration" ? integrationFile(file) : file.endsWith(suite.suffix) && !integrationFile(file));
if (selected.length) {
  for (const file of selected) if (!files.includes(file)) throw new Error(`Unknown ${name} test: ${file}`);
  files = selected;
}
if (shard) {
  // Heaviest first, each to the lightest shard so far (ties to the lowest): every shard computes the same split.
  // With no weights this deals the files round robin in name order, so each shard gets a mix of slow and quick.
  const load = Array(shard.total).fill(0);
  const weigh = file => suite.weight?.[file] ?? 1;
  const owner = new Map();
  for (const file of [...files].sort((a, b) => weigh(b) - weigh(a))) {
    const lightest = load.indexOf(Math.min(...load));
    owner.set(file, lightest);
    load[lightest] += weigh(file);
  }
  files = files.filter(file => owner.get(file) === shard.index - 1);
}
const quiet = files.filter(file => suite.quiet.includes(file));
const together = files.filter(file => !suite.quiet.includes(file));

const run = (list, parallel) => list.length === 0 ? Promise.resolve(0) : new Promise(resolve => {
  const child = spawn(
    process.execPath,
    ["--import", suite.loader, "--experimental-strip-types", "--test", `--test-concurrency=${parallel}`, ...options, ...list],
    {
      cwd: root,
      stdio: "inherit",
      // A shared compile cache saves each file's process re-compiling the same dependencies.
      env: { NODE_COMPILE_CACHE: join(tmpdir(), "camelrun-workers-compile-cache"), ...process.env },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});
const first = await run(together, concurrency);
const second = await run(quiet, 1);
process.exit(first || second);
