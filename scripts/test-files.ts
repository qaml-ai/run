import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "node:test";
import { spec, tap } from "node:test/reporters";
import failures from "./test-failures-reporter.ts";
import timings from "./test-timings-reporter.ts";

const [timingsOut, failuresOut, ...files] = process.argv.slice(2);
// The CLI sorts paths alphabetically. Supplying files to run() keeps the planner's longest-first order.
const tests = run({
  files: files.map(file => resolve(file)),
  concurrency: Number(process.env.TEST_CONCURRENCY ?? 1),
  timeout: Number(process.execArgv.find(arg => arg.startsWith("--test-timeout="))?.split("=")[1] ?? 240_000),
});
tests.on("test:fail", () => { process.exitCode = 1; });
await Promise.all([
  pipeline(tests.pipe(Duplex.from(process.stdout.isTTY ? spec : tap)), process.stdout),
  pipeline(tests.pipe(Duplex.from(timings)), createWriteStream(timingsOut)),
  pipeline(tests.pipe(Duplex.from(failures)), createWriteStream(failuresOut)),
]);
