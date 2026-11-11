// Check every Workers copy of runtime source against src/: each scripts/reuse-*.mjs and scripts/port-*-tests.mjs
// regenerates its files from src/ (and packages/cli/src/), and with --check fails when a copy differs. Fix a failure
// by running that script without --check and committing what it writes, never by editing the copy.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const scripts = readdirSync(dir).filter(name => /^reuse-.+\.mjs$|^port-.+-tests\.mjs$/.test(name)).sort();
const failed = [];
for (const name of scripts) {
  const run = spawnSync(process.execPath, [name, "--check"], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0) failed.push(`${name}: ${(run.stderr || run.stdout).split("\n").find(line => /Error/.test(line)) ?? `exit ${run.status}`}`);
}
if (failed.length) {
  console.error(`Workers copies drifted from src/ (run each script without --check and commit):\n${failed.map(line => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`${scripts.length} generated Workers copies match src/`);
