import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { excludedCases } from "./scopes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "backends/workers/measurements");
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const backend = option("backend") ?? "both", area = option("area");
if (!["node", "workers", "both"].includes(backend)) throw new Error("--backend must be node, workers, or both");
const files = (await readdir(path.join(root, "tests/contract/areas"))).filter(file => file.endsWith(".test.ts")).sort();
async function walk(directory) {
  const entries = (await readdir(path.join(root, directory), { withFileTypes: true }))
    .filter(entry => !["node_modules", "dist", ".wrangler", ".git"].includes(entry.name));
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]))).flat();
}
const suiteFiles = [...await walk("src"), ...await walk("clients"), ...await walk("tests"), ...await walk("packages"), ...await walk("migrations"), ...await walk("backends/workers/src"), ...await walk("backends/workers/codemode")]
  .filter(file => /\.(ts|mjs|py|sql)$/.test(file));
suiteFiles.push("package.json", "package-lock.json", "backends/workers/package-lock.json", "backends/workers/test/fixture.ts", "backends/workers/test/local-worker.ts", "backends/workers/test/contract-entry.ts", "backends/workers/wrangler.test.jsonc", "backends/workers/codemode/wrangler.jsonc");
const hash = createHash("sha256");
for (const file of suiteFiles.sort()) hash.update(file).update(await readFile(path.join(root, file)));
const suiteHash = hash.digest("hex");
let revision = process.env.CONTRACT_REVISION;
if (!revision) {
  try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { revision = "archive (identified by suiteHash)"; } // Sprites receives a git archive, without .git.
}
await mkdir(output, { recursive: true });
const suffix = area ? `-${area.replace(/[^a-z0-9-]/gi, "_")}` : "";
const reportPath = backend => path.join(output, `parity-${backend}${suffix}.json`);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function command(program, commandArgs, env, expected = []) {
  const rows = [], cases = [], chunks = [];
  const child = spawn(program, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let killDeadline;
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    killDeadline ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5_000);
  };
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
  if (pending) line(pending);
  return { ...result, rows, cases, log: Buffer.concat(chunks).toString() };
}

const inventory = (await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "tests/contract/list.mjs"], {}));
if (inventory.code !== 0) throw new Error(`Cannot load contract inventory: ${inventory.log.slice(-5000)}`);
const pythonInventory = await command("python3", ["tests/contract/python.py", "--list"], {});
if (pythonInventory.code !== 0) throw new Error(`Cannot load Python inventory: ${pythonInventory.log.slice(-5000)}`);
const scope = await excludedCases();
const manifest = [...inventory.cases, ...pythonInventory.cases, ...scope].filter(row => !area || area.split(",").includes(row.area));
const key = row => `${row.area}\0${row.source}\0${row.name}`;
if (new Set(manifest.map(key)).size !== manifest.length) throw new Error("Contract inventory contains duplicate case identities");
if (!manifest.length) throw new Error(`No contract cases in area ${area}`);
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
  const rows = manifest.filter(row => row.file === "scope"), logs = [];
  const jobs = [...new Set(manifest.filter(row => row.file !== "scope").map(row => row.file))];
  const concurrency = Number(process.env.CONTRACT_CONCURRENCY ?? (which === "node" ? 2 : 1));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("CONTRACT_CONCURRENCY must be an integer from 1 to 8");
  async function next() {
    for (;;) {
      const file = jobs.shift(); if (!file) return;
      const expected = manifest.filter(row => row.file === file);
      console.log(`START ${which} ${file} (${expected.length})`);
      const result = file.endsWith(".py")
        ? await command("python3", [file], { CONTRACT_BACKEND: which }, expected)
        : await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", `--test-reporter=${path.join(root, "tests/contract/reporter.mjs")}`,
          ...(area ? [`--test-name-pattern=^\\[(?:${area.split(",").map(escape).join("|")})\\]`] : []), file], { CONTRACT_BACKEND: which }, expected);
      rows.push(...complete(result.rows, expected, result)); logs.push(result.log);
      await writeFile(path.join(output, `parity-${which}${suffix}.partial.json`), JSON.stringify({ backend: which, suiteHash, revision, rows }, null, 2) + "\n");
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, next));
  rows.sort((a, b) => key(a).localeCompare(key(b)));
  const report = { backend: which, area: area ?? "all", suiteHash, revision, runtime: { node: process.version, platform: process.platform, arch: process.arch }, recordedAt: new Date().toISOString(), expectedCases: manifest.length, rows };
  await writeFile(reportPath(which), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(output, `parity-${which}${suffix}.log`), logs.join("\n"));
  const count = status => rows.filter(row => row.status === status).length;
  console.log(`${which}: ${count("pass")} pass, ${count("fail")} fail, ${count("out-of-scope")} out of scope`);
  return report;
}

let node;
if (backend !== "workers") node = await run("node");
else node = JSON.parse(await readFile(reportPath("node"), "utf8").catch(() => { throw new Error("Run the Node baseline first with the same --area; no baseline report exists"); }));
const nodeGreen = node.suiteHash === suiteHash && node.expectedCases === manifest.length && node.rows.length === manifest.length && manifest.every(row => node.rows.some(result => key(row) === key(result))) && !node.rows.some(row => row.status === "fail");
if (backend !== "node" && !nodeGreen) throw new Error("Node baseline is not green for this exact suite. Fix the contract or Node fixture before running Workers.");
let workers;
if (backend !== "node") workers = await run("workers");

if (!area && workers) {
  const clean = value => String(value ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 280);
  const nodeRows = new Map(node.rows.map(row => [`${row.source}:${row.name}`, row]));
  const areas = [...new Set(workers.rows.map(row => row.area))].sort();
  const lines = ["# Workers public contract parity", "", `Generated by \`npm run parity\` at ${workers.recordedAt}. Suite SHA-256: \`${suiteHash}\`.`, "", "The same assertions run against Node first, then real local workerd. Each fixture has an isolated migrated database. No production credentials or cloud resources are used. SDK-only tests are recorded separately and do not count as backend passes.", "", "| Area | Node pass | Workers HTTP pass | SDK-only pass | Fail | Out of scope |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const group of areas) {
    const rs = workers.rows.filter(r => r.area === group);
    lines.push(`| ${group} | ${rs.filter(r => nodeRows.get(`${r.source}:${r.name}`)?.status === "pass").length} | ${rs.filter(r => r.status === "pass" && r.backend === "workers").length} | ${rs.filter(r => r.status === "pass" && r.backend === "sdk-unit").length} | ${rs.filter(r => r.status === "fail").length} | ${rs.filter(r => r.status === "out-of-scope").length} |`);
  }
  lines.push("", "Channels and voice/audio transport are deliberately out of scope. Internal storage/process assertions remain in their source suites; migration coverage and remaining gaps are listed in `tests/contract/COVERAGE.md`.", "", "Run one area with `npm run parity -- --area=history` (Node gate, then Workers), or only the Node baseline with `npm run parity -- --backend=node --area=history`. Full JSON assertion details and raw output are in `backends/workers/measurements/parity-{node,workers}.{json,log}`.");
  for (const group of areas) {
    lines.push("", `## ${group}`, "", "| Case / source | Node | Workers | Failure reason |", "| --- | --- | --- | --- |");
    for (const row of workers.rows.filter(r => r.area === group)) lines.push(`| ${clean(row.name)} (\`${clean(row.source)}\`) | ${nodeRows.get(`${row.source}:${row.name}`)?.status ?? "missing"} | ${row.status}${row.backend === "sdk-unit" ? " (SDK only)" : ""} | ${row.status === "fail" ? clean(row.reason) : ""} |`);
  }
  await writeFile(path.join(root, "backends/workers/PARITY.md"), lines.join("\n") + "\n");
}
process.exitCode = (!nodeGreen || workers?.rows.some(row => row.status === "fail")) ? 1 : 0;
