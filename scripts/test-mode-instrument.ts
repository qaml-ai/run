// Opt-in measurement instrumentation, applied only to disposable CI test checkouts.
// No application source changes are committed or shipped.
import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("../src/supervisor.ts", import.meta.url);
let source = readFileSync(file, "utf8");
let count = 0;
source = source.replace(/this\.hosting === "inline"|handle\.kind === "process"/g, expression => {
  const label = `supervisor:${++count}`;
  return `(__modeHit(${JSON.stringify(label)}, ${expression}))`;
});
if (count !== 4) throw new Error(`Review instrumentation: expected four hosting branches, found ${count}`);
source = `import { appendFileSync as __modeAppend } from "node:fs";
const __modeSeen = new Set<string>();
function __modeHit(label: string, result: boolean) {
  const key = label + ":" + result;
  if (process.env.TEST_MODE_OWNER && process.env.TEST_MODE_TRACE_DIR && !__modeSeen.has(key)) {
    __modeSeen.add(key);
    __modeAppend(process.env.TEST_MODE_TRACE_DIR + "/" + process.env.TEST_MODE_OWNER + ".jsonl", JSON.stringify({ branch: label, result, pid: process.pid }) + "\\n");
  }
  return result;
}
` + source;
writeFileSync(file, source);
