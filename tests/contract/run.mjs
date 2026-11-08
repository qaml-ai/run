import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { excludedCases } from "./scopes.mjs";
import { sourceKeys, caseKey as key, selectCases, partitionFiles, greenFor, loadBaseline, saveBaseline, mergeReports, walk } from "./harness.mjs";
import { serialFiles } from "./groups.mjs";
import { acceptedDifference, differenceResult, validateDifferences, validateDifferenceInventory } from "./accepted-differences.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const backend = option("backend") ?? "both", area = option("area"), group = option("group"), selectedFiles = option("files");
const output = path.resolve(root, option("output-dir") ?? "backends/workers/measurements");
if (!["node", "workers", "both"].includes(backend)) throw new Error("--backend must be node, workers, or both");
const { nodeKey, suiteHash } = await sourceKeys(root);
const shardOption = option("shard");
const shard = shardOption ? (() => {
  const match = /^(\d+)\/(\d+)$/.exec(shardOption);
  if (!match || +match[1] < 1 || +match[1] > +match[2] || +match[2] > 40) throw new Error("--shard must be i/N with 1 <= i <= N <= 40");
  return { index: +match[1], total: +match[2] };
})() : undefined;
let revision = process.env.CONTRACT_REVISION;
if (!revision) {
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { revision = "archive (identified by suiteHash)"; } // Sprites receives a git archive, without .git.
}
await mkdir(output, { recursive: true });
const selection = [group ? `group-${group}` : "", area ?? "", selectedFiles ? "files" : ""].filter(Boolean).join("-");
const suffix = (selection ? `-${selection.replace(/[^a-z0-9-]/gi, "_")}` : "") + (shard ? `-shard-${shard.index}-of-${shard.total}` : "");
const reportPath = backend => path.join(output, `parity-${backend}${suffix}.json`);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const title = row => `[${row.area}] ${row.source} :: ${row.name}`;
const activeCommands = new Set();
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`Contract runner stopping: ${signal}`);
  for (const command of activeCommands) command.stop();
  // Fixtures get time to stop their separately owned workerd processes. The
  // runner can then terminate only the process groups it started itself.
  setTimeout(() => {
    for (const command of activeCommands) command.kill();
    process.exit(signal === "SIGINT" ? 130 : 143);
  }, 5_000);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function command(program, commandArgs, env, expected = []) {
  if (stopping) throw new Error("Contract runner was cancelled");
  const rows = [], cases = [], chunks = [];
  const child = spawn(program, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let killDeadline;
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    killDeadline ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5_000);
  };
  const owned = { stop, kill: () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
  activeCommands.add(owned);
  const deadline = setTimeout(stop, Math.max(120_000, expected.length * 120_000));
  let cleanupDeadline;
  let pending = "";
  const line = value => {
    if (value.startsWith("@@CONTRACT_RESULT@@")) {
      const row = JSON.parse(value.slice(19));
      rows.push(row);
      if (program === "python3") console.log(`${row.status.toUpperCase()} [${row.area}] ${row.name}${row.status === "fail" ? `: ${row.reason}` : ""}`);
      if (expected.length && rows.length >= expected.length && !cleanupDeadline) cleanupDeadline = setTimeout(stop, 15_000);
    } else if (value.startsWith("@@CONTRACT_CASE@@")) cases.push(JSON.parse(value.slice(17)));
    else if (value) console.log(value);
  };
  child.stdout.on("data", chunk => {
    chunks.push(chunk); pending += String(chunk);
    const lines = pending.split("\n"); pending = lines.pop(); lines.forEach(line);
  });
  child.stderr.on("data", chunk => { chunks.push(chunk); });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline); clearTimeout(cleanupDeadline); clearTimeout(killDeadline);
  activeCommands.delete(owned);
  if (pending) line(pending);
  return { ...result, rows, cases, log: Buffer.concat(chunks).toString() };
}

const inventory = (await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "tests/contract/list.mjs"], {}));
if (inventory.code !== 0) throw new Error(`Cannot load contract inventory: ${inventory.log.slice(-5000)}`);
const pythonInventory = await command("python3", ["tests/contract/python.py", "--list"], {});
if (pythonInventory.code !== 0) throw new Error(`Cannot load Python inventory: ${pythonInventory.log.slice(-5000)}`);
const scope = await excludedCases();
const allCases = [...inventory.cases, ...pythonInventory.cases, ...scope];
if (new Set(allCases.map(key)).size !== allCases.length) throw new Error("Contract inventory contains duplicate case identities");
validateDifferenceInventory(allCases);
const selected = selectCases(allCases, { area, group, files: selectedFiles });
if (!selected.length) throw new Error(`No contract cases match the selection`);
let baseline = await loadBaseline(root, nodeKey, selected);
// Sharding always uses the same stable plan on each machine: the checked-in
// Node cache, never a machine-specific partial cache or a live Workers timing.
const planBaseline = await readFile(path.join(root, "backends/workers/measurements/node-baselines", `${nodeKey}.json`), "utf8").then(JSON.parse).catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const plan = shard ? partitionFiles(selected, shard.total, greenFor(planBaseline, allCases, nodeKey) ? planBaseline.rows : []) : null;
const manifest = shard ? selected.filter(row => row.file === "scope" ? shard.index === 1 : plan[shard.index - 1].includes(row.file)) : selected;
if (args.includes("--list")) { console.log(JSON.stringify(manifest, null, 2)); process.exit(0); }

function complete(rows, expected, processResult) {
  const seen = new Set();
  const expectedIds = new Set(expected.map(key));
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) throw new Error(`Duplicate result: ${row.name}`);
    if (!expectedIds.has(id) && !(row.area === "harness" && row.status === "fail")) throw new Error(`Unexpected result outside the contract inventory: ${row.name}`);
    seen.add(id);
  }
  for (const row of expected) if (!seen.has(key(row))) rows.push({ ...row, status: "fail", backend: "fixture", reason: "Test process did not report this case; inspect raw log" });
  if (processResult.signal || (processResult.code !== 0 && !rows.some(row => row.status === "fail"))) rows.push({ area: "harness", name: `process cleanup: ${expected[0]?.file}`, source: "tests/contract/run.mjs", status: "fail", backend: "fixture", reason: `Test process ended with ${processResult.signal ?? processResult.code}` });
  return rows;
}

async function run(which) {
  console.log(`Contract baseline: ${which}${area ? ` / ${area}` : ""} (${manifest.length} cases)`);
  const started = performance.now();
  const differences = manifest.filter(row => acceptedDifference(row, which));
  const executable = manifest.filter(row => !acceptedDifference(row, which));
  const rows = [...manifest.filter(row => row.file === "scope"), ...differences.map(differenceResult)], logs = new Map();
  const files = [...new Set(executable.filter(row => row.file !== "scope").map(row => row.file))].sort();
  const jobs = files.filter(file => !Object.hasOwn(serialFiles, file));
  const serial = files.filter(file => Object.hasOwn(serialFiles, file));
  const concurrency = Number(process.env.CONTRACT_CONCURRENCY ?? (which === "workers" ? 2 : 6));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("CONTRACT_CONCURRENCY must be an integer from 1 to 16");
  if (which === "workers" && files.length) {
    console.log("Preparing Workers runtime before parallel cases");
    const warmup = await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "tests/contract/warm-workers.mjs"], {});
    if (warmup.code !== 0) throw new Error(`Workers preparation failed: ${warmup.log.slice(-5000)}`);
    logs.set("warmup", warmup.log);
  }
  async function next() {
    for (;;) {
      if (stopping) return;
      const file = jobs.shift(); if (!file) return;
      const expected = executable.filter(row => row.file === file);
      console.log(`START ${which} ${file} (${expected.length})`);
      const result = file.endsWith(".py")
        ? await command("python3", [file], { CONTRACT_BACKEND: which, CONTRACT_PYTHON_CONCURRENCY: process.env.CONTRACT_PYTHON_CONCURRENCY ?? (which === "workers" ? "2" : "4"), ...(baseline ? { CONTRACT_NODE_BASELINE: baseline.filename } : {}) }, expected)
        : await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-reporter=${path.join(root, "tests/contract/reporter.mjs")}`,
          ...((area || group || selectedFiles || differences.length) ? [`--test-name-pattern=^(?:${expected.map(row => escape(title(row))).join("|")})$`] : []), file], { CONTRACT_BACKEND: which, ...(baseline ? { CONTRACT_NODE_BASELINE: baseline.filename } : {}) }, expected);
      rows.push(...complete(result.rows, expected, result)); logs.set(file, result.log);
      await writeFile(path.join(output, `parity-${which}${suffix}.partial.json`), JSON.stringify({ backend: which, nodeKey, suiteHash, revision, rows }, null, 2) + "\n");
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, next));
  jobs.push(...serial);
  await next();
  validateDifferences(rows, which);
  rows.sort((a, b) => key(a).localeCompare(key(b)));
  const report = { backend: which, area: area ?? "all", group, nodeKey, suiteHash, revision, shard, durationMs: performance.now() - started, runtime: { node: process.version, platform: process.platform, arch: process.arch }, recordedAt: new Date().toISOString(), expectedCases: manifest.length, rows };
  await writeFile(reportPath(which), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(output, `parity-${which}${suffix}.log`), [...logs].sort(([a], [b]) => a.localeCompare(b)).map(([, log]) => log).join("\n"));
  const count = status => rows.filter(row => row.status === status).length;
  console.log(`${which}: ${count("pass")} pass, ${count("accepted-difference")} accepted difference, ${count("fail")} fail, ${count("out-of-scope")} out of scope`);
  if (which === "node") await saveBaseline(root, report);
  return report;
}

let node, workers;
const mergeDirectory = option("merge");
if (mergeDirectory) {
  const directory = path.resolve(mergeDirectory);
  const paths = (await walk(directory, "")).filter(file => /parity-(?:node|workers).*\.json$/.test(file) && !file.includes(".partial."));
  const reports = await Promise.all(paths.map(file => readFile(path.join(directory, file), "utf8").then(JSON.parse)));
  async function mergeLogs(which) {
    const selected = reports.map((report, index) => ({ report, file: paths[index] })).filter(({ report }) => report.backend === which).sort((a, b) => a.report.shard.index - b.report.shard.index);
    const logs = await Promise.all(selected.map(async ({ report, file }) => {
      const log = await readFile(path.join(directory, file.replace(/\.json$/, ".log")), "utf8").catch(error => {
        if (error.code === "ENOENT") return "No raw log was collected.\n";
        throw error;
      });
      return `=== shard ${report.shard.index}/${report.shard.total} ===\n${log}`;
    }));
    await writeFile(path.join(output, `parity-${which}${suffix}.log`), logs.join("\n"));
  }
  if (backend !== "workers") {
    node = mergeReports(reports.filter(report => report.backend === "node"), selected, { backend: "node", nodeKey, suiteHash });
    await writeFile(reportPath("node"), JSON.stringify(node, null, 2) + "\n");
    await mergeLogs("node");
    await saveBaseline(root, node);
    baseline = await loadBaseline(root, nodeKey, selected);
  } else node = baseline?.report;
  if (backend !== "node") {
    workers = mergeReports(reports.filter(report => report.backend === "workers"), selected, { backend: "workers", nodeKey, suiteHash });
    await writeFile(reportPath("workers"), JSON.stringify(workers, null, 2) + "\n");
    await mergeLogs("workers");
  }
} else {
  if (backend !== "workers") {
    node = await run("node");
    baseline = await loadBaseline(root, nodeKey, manifest);
  } else {
    baseline = await loadBaseline(root, nodeKey, manifest);
    node = baseline?.report;
    if (!manifest.length) node = { backend: "node", nodeKey, rows: [] };
    if (baseline) console.log(`Reusing Node baseline ${nodeKey} (${manifest.length} selected cases)`);
  }
  if (backend !== "node" && !greenFor(node, manifest, nodeKey)) throw new Error(`No green Node baseline for key ${nodeKey} and all selected cases. Run npm run parity -- --backend=node with this selection first.`);
  if (backend !== "node") workers = await run("workers");
}
const nodeGreen = greenFor(node, mergeDirectory ? selected : manifest, nodeKey);
if (backend !== "node" && !nodeGreen) throw new Error("Node baseline is not green for this selection and Node source key");

if (!area && !group && !selectedFiles && !shard && workers) {
  const clean = value => String(value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 280);
  const nodeRows = new Map(node.rows.map(row => [`${row.source}:${row.name}`, row]));
  const areas = [...new Set(workers.rows.map(row => row.area))].sort();
  const count = (rows, status, backend) => rows.filter(row => row.status === status && (!backend || row.backend === backend)).length;
  const lines = ["# Workers public contract parity", "", `Generated by \`npm run parity\` at ${workers.recordedAt}. Suite SHA-256: \`${suiteHash}\`.`, "", "The same assertions run against Node first, then real local workerd. Each fixture has an isolated migrated database. The fixtures use local services and fake providers; this run may execute on a Sprite. No production credentials or deployed Cloudflare resources are used. SDK-only tests are recorded separately and do not count as backend passes.", "", `**Node: ${count(node.rows, "pass", "node")} HTTP pass, ${count(node.rows, "pass", "sdk-unit")} SDK-only pass, ${count(node.rows, "accepted-difference")} accepted difference, ${count(node.rows, "fail")} fail. Workers: ${count(workers.rows, "pass", "workers")} HTTP pass, ${count(workers.rows, "pass", "sdk-unit")} SDK-only pass, ${count(workers.rows, "accepted-difference")} accepted difference, ${count(workers.rows, "fail")} fail. ${count(workers.rows, "out-of-scope")} voice cases are out of scope.**`, "", "| Area | Node HTTP pass | Workers HTTP pass | SDK-only pass | Accepted difference | Fail | Out of scope |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const group of areas) {
    const rs = workers.rows.filter(r => r.area === group);
    lines.push(`| ${group} | ${rs.filter(r => nodeRows.get(`${r.source}:${r.name}`)?.status === "pass" && nodeRows.get(`${r.source}:${r.name}`)?.backend === "node").length} | ${rs.filter(r => r.status === "pass" && r.backend === "workers").length} | ${rs.filter(r => r.status === "pass" && r.backend === "sdk-unit").length} | ${rs.filter(r => r.status === "accepted-difference").length} | ${rs.filter(r => r.status === "fail").length} | ${rs.filter(r => r.status === "out-of-scope").length} |`);
  }
  lines.push("", "Accepted differences are explicitly reviewed in `tests/contract/accepted-differences.mjs`. They are not passes or out of scope: Workers does not execute those backend-specific cases, while Node must run and pass every original assertion. Reasons and reviewer metadata are recorded in that single registry.", "", "Voice/audio transport is deliberately out of scope; channels are in scope (their cases are in `tests/contract/areas/channels*.contract.test.ts`). Internal storage/process assertions remain in their source suites; migration coverage and remaining gaps are listed in `tests/contract/COVERAGE.md`.", "", "Run one area with `npm run parity -- --area=history` (Node gate, then Workers), or only the Node baseline with `npm run parity -- --backend=node --area=history`. Full JSON assertion details and raw output are in `backends/workers/measurements/parity-{node,workers}.{json,log}`.");
  for (const group of areas) {
    lines.push("", `## ${group}`, "", "| Case / source | Node | Workers | Failure or accepted-difference reason |", "| --- | --- | --- | --- |");
    for (const row of workers.rows.filter(r => r.area === group)) lines.push(`| ${clean(row.name)} (\`${clean(row.source)}\`) | ${nodeRows.get(`${row.source}:${row.name}`)?.status ?? "missing"}${nodeRows.get(`${row.source}:${row.name}`)?.backend === "sdk-unit" ? " (SDK only)" : ""} | ${row.status}${row.backend === "sdk-unit" ? " (SDK only)" : ""} | ${["fail", "accepted-difference"].includes(row.status) ? clean(row.reason) : ""} |`);
  }
  await writeFile(path.join(root, "backends/workers/PARITY.md"), lines.join("\n") + "\n");
}
process.exitCode = (!nodeGreen || workers?.rows.some(row => row.status === "fail")) ? 1 : 0;
