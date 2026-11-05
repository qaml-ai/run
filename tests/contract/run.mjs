import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "backends/workers/measurements");
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const backend = option("backend") ?? "both", area = option("area");
if (!["node", "workers", "both"].includes(backend)) throw new Error("--backend must be node, workers, or both");
const files = (await readdir(path.join(root, "tests/contract/areas"))).filter(file => file.endsWith(".test.ts")).sort();
const suiteFiles = ["fixture.ts", "support.ts", "http.ts", "python.py", "fixtures/node.ts", ...files.map(file => `areas/${file}`)];
const hash = createHash("sha256");
for (const file of suiteFiles) hash.update(file).update(await readFile(path.join(root, "tests/contract", file)));
const suiteHash = hash.digest("hex");
await mkdir(output, { recursive: true });
const suffix = area ? `-${area.replace(/[^a-z0-9-]/gi, "_")}` : "";
const reportPath = backend => path.join(output, `parity-${backend}${suffix}.json`);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function command(program, commandArgs, env) {
  const rows = [], chunks = [];
  const child = spawn(program, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let pending = "";
  child.stdout.on("data", chunk => {
    chunks.push(chunk);
    pending += String(chunk);
    const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith("@@CONTRACT_RESULT@@")) rows.push(JSON.parse(line.slice(19)));
      else if (line) console.log(line);
    }
  });
  child.stderr.on("data", chunk => { chunks.push(chunk); /* raw diagnostic details remain in the log */ });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, rows, log: Buffer.concat(chunks).toString() };
}

async function run(which) {
  console.log(`Contract baseline: ${which}${area ? ` / ${area}` : ""}`);
  const rows = [], logs = [];
  let failed = false;
  if (area !== "python") {
    const result = await command(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-concurrency=1", "--test-timeout=180000", `--test-reporter=${path.join(root, "tests/contract/reporter.mjs")}`,
      ...(area ? [`--test-name-pattern=^\\[(?:${area.split(",").map(escape).join("|")})\\]`] : []),
      ...files.map(file => path.join(root, "tests/contract/areas", file))], { CONTRACT_BACKEND: which });
    rows.push(...result.rows); logs.push(result.log); failed ||= result.code !== 0;
  }
  if (!area || area.split(",").includes("python")) {
    const result = await command("python3", ["tests/contract/python.py"], { CONTRACT_BACKEND: which });
    rows.push(...result.rows); logs.push(result.log); failed ||= result.code !== 0;
  }
  if (!rows.length || (failed && !rows.some(row => row.status === "fail"))) rows.push({ area: "harness", name: "runner completed", source: "tests/contract/run.mjs", status: "fail", backend: "fixture", reason: "A test process failed before reporting its cases; inspect raw log" });
  const report = { backend: which, area: area ?? "all", suiteHash, recordedAt: new Date().toISOString(), rows };
  await writeFile(reportPath(which), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(output, `parity-${which}${suffix}.log`), logs.join("\n"));
  const count = status => rows.filter(row => row.status === status).length;
  console.log(`${which}: ${count("pass")} pass, ${count("fail")} fail, ${count("out-of-scope")} out of scope`);
  return report;
}

let node;
if (backend !== "workers") node = await run("node");
else node = JSON.parse(await readFile(reportPath("node"), "utf8").catch(() => { throw new Error("Run the Node baseline first with the same --area; no baseline report exists"); }));
const nodeGreen = node.suiteHash === suiteHash && !node.rows.some(row => row.status === "fail");
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
