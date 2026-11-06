import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  ?? (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
function withoutOptions(names) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "").split("=")[0];
    if (!names.includes(name)) result.push(args[i]);
    else if (!args[i].includes("=") && ["shards", "ref", "backend"].includes(name)) i++;
  }
  return result;
}
async function command(program, commandArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : code ?? 1));
  });
}

// Inventory/merge are cheap local operations. The actual tests run on the pool
// unless a caller explicitly selects local execution or is already on a Sprite.
if (option("ref")) throw new Error("Check out the source ref before running parity; reports must be merged against that same source tree");
if (process.env.CONTRACT_ON_SPRITE === "1" || args.includes("--local") || args.includes("--list") || option("merge")) {
  process.exitCode = await command(process.execPath, ["tests/contract/run.mjs", ...withoutOptions(["local", "shards", "ref"])]);
} else {
  const shards = Number(option("shards") ?? process.env.CONTRACT_SPRITES ?? 6);
  if (!Number.isInteger(shards) || shards < 1 || shards > 40) throw new Error("--shards must be an integer from 1 to 40");
  if (option("shard") || option("output-dir")) throw new Error("Use --local for a single shard or a custom output directory");
  const backend = option("backend") ?? "both";
  if (!["node", "workers", "both"].includes(backend)) throw new Error("--backend must be node, workers, or both");
  const selected = withoutOptions(["local", "shards", "ref", "backend"]);
  const started = Date.now();
  const runId = `${new Date(started).toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const artifacts = path.join(root, "backends/workers/measurements/runs", runId);
  await mkdir(artifacts, { recursive: true });
  console.log(`Contract pool: ${shards} Sprites; artifacts ${path.relative(root, artifacts)}`);
  const forwardedEnv = ["CONTRACT_CONCURRENCY", "CONTRACT_PYTHON_CONCURRENCY", "CONTRACT_TIMEOUT_MS"].flatMap(name => {
    if (process.env[name] === undefined) return [];
    if (!/^[1-9][0-9]*$/.test(process.env[name])) throw new Error(`${name} must be a positive integer`);
    return [`${name}=${process.env[name]}`];
  });
  const phases = [];
  for (const which of backend === "both" ? ["node", "workers"] : [backend]) {
    const phaseArtifacts = path.join(artifacts, which);
    await mkdir(phaseArtifacts);
    const phaseArgs = [`--backend=${which}`, ...selected];
    const phaseStarted = Date.now();
    const status = await command("bash", ["scripts/sprite-test", `--shards=${shards}`, "--artifacts=.contract-artifacts", `--output=${phaseArtifacts}`, "--contract-baselines",
      "HEAD", "env", ...forwardedEnv, "bash", "tests/contract/sprite-shard.sh", ...phaseArgs, "--shard={shard}/{shards}", "--output-dir=.contract-artifacts"]);
    // A parity mismatch exits 1 and still has complete reports. Merge even on
    // fixture errors so missing reports and unexpected cases are diagnosed.
    const mergeStatus = await command(process.execPath, ["tests/contract/run.mjs", ...phaseArgs, `--merge=${phaseArtifacts}`]);
    phases.push({ backend: which, elapsedMs: Date.now() - phaseStarted, status, mergeStatus });
    if (status || mergeStatus) break;
    // A Workers phase starts only after every selected Node case passed. The
    // next pool run receives the merged cache, including an uncommitted one.
  }
  const elapsedMs = Date.now() - started;
  const status = phases.find(phase => phase.status || phase.mergeStatus);
  await writeFile(path.join(artifacts, "run.json"), JSON.stringify({ shards, elapsedMs, status: status?.status || status?.mergeStatus || 0, phases, args }, null, 2) + "\n");
  console.log(`Contract pool elapsed: ${(elapsedMs / 1000).toFixed(1)}s (${shards} Sprites)`);
  process.exitCode = status?.status || status?.mergeStatus || 0;
}
