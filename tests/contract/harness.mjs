import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { groups, groupFor } from "./groups.mjs";

export const caseKey = row => `${row.area}\0${row.source}\0${row.name}`;
const excludedDirectories = new Set(["node_modules", "dist", "target", ".wrangler", ".git", "__pycache__", ".venv", "build"]);
const workerOnly = file => file.startsWith("backends/workers/") || file === "tests/contract/fixtures/workers.ts";
const generatedInput = file => file.split("/").some(part => excludedDirectories.has(part));

export async function walk(root, directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (await Promise.all(entries.filter(entry => !excludedDirectories.has(entry.name)).map(entry => {
    const file = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? walk(root, file) : entry.isFile() ? [file] : [];
  }))).flat();
}

async function contentHash(root, files) {
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const content = await readFile(path.join(root, file));
    // Length-prefix the fields so file boundaries cannot collide.
    hash.update(`${Buffer.byteLength(file)}:${file}:${content.length}:`).update(content);
  }
  return hash.digest("hex");
}

/** Inputs used by Node, including data files and vendored/local dependencies. */
export async function sourceKeys(root, { details = false } = {}) {
  const nodeFiles = new Set();
  for (const directory of ["src", "sdk", "clients", "shared", "sandbox", "migrations", "vendor", "docs"]) {
    for (const file of await walk(root, directory)) nodeFiles.add(file);
  }
  for (const file of await walk(root, "tests/contract")) {
    const harnessTest = (/\.test\.(?:mjs|ts)$/.test(file) || /_test\.py$/.test(file)) && !file.startsWith("tests/contract/areas/");
    if (!workerOnly(file) && /\.(?:[cm]?[jt]s|py|json)$/.test(file) && !harnessTest) nodeFiles.add(file);
  }
  for (const file of ["package.json", "package-lock.json", "openapi.json", "tests/runtime-server.ts", "tests/fake-launcher.ts", "tests/database.ts", "tests/python_sdk.py"]) nodeFiles.add(file);
  // Follow local imports and URL-based data/entrypoint references. This covers
  // imported package code, console helpers, nested fixtures and future helpers
  // without hashing unrelated implementation test bodies or Workers sources.
  const pending = [...nodeFiles];
  const scanned = new Set();
  const localPackages = new Map();
  // Most local imports use relative paths. Resolve bare workspace package
  // names as well, without adding unrelated package trees to the key.
  for (const directory of ["sdk", ...(await readdir(path.join(root, "packages")).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).map(name => `packages/${name}`)]) {
    const manifest = await readFile(path.join(root, directory, "package.json"), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (manifest?.name) localPackages.set(manifest.name, directory);
  }
  while (pending.length) {
    const file = pending.pop();
    if (scanned.has(file) || !/\.(?:[cm]?[jt]s|py)$/.test(file)) continue;
    scanned.add(file);
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const packageName = match[1].startsWith("@") ? match[1].split("/").slice(0, 2).join("/") : match[1].split("/")[0];
      const directory = localPackages.get(packageName);
      if (!directory) continue;
      for (const dependency of await walk(root, directory)) if (!generatedInput(dependency) && !nodeFiles.has(dependency)) {
        nodeFiles.add(dependency); pending.push(dependency);
      }
    }
    for (const match of source.matchAll(/["'](\.{1,2}\/[^"'\n]+)["']/g)) {
      // normalize preserves a trailing slash (including "./"), so strip it
      // before comparing repository/ancestor directories.
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])).replace(/\/+$/, "") || ".";
      // Runner root-directory constants are not imported inputs. Expanding one
      // would pull unrelated worktrees, measurements and Workers code into the
      // Node key (and make the cache self-referential).
      if (relative === "." || relative.startsWith("../") || workerOnly(relative) || generatedInput(relative)) continue;
      const info = await stat(path.join(root, relative)).catch(error => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!info) continue;
      const parent = path.posix.dirname(file);
      // ../ often locates the harness/repo itself (for example scopes.mjs).
      // Only explicit child/data directories are inputs; never expand a
      // directory containing the referring file into unrelated test suites.
      if (info.isDirectory() && (parent === relative || parent.startsWith(`${relative}/`))) continue;
      const found = info.isDirectory() ? await walk(root, relative) : [relative];
      for (const dependency of found) if (!workerOnly(dependency) && !generatedInput(dependency) && !nodeFiles.has(dependency)) {
        nodeFiles.add(dependency); pending.push(dependency);
      }
    }
  }
  // Scope inventory reads these source files without importing them.
  for (const file of await readdir(path.join(root, "tests"))) if (/^(?:channels?|voice|speech|transcription).*\.test\.ts$/.test(file)) nodeFiles.add(`tests/${file}`);
  const nodeKey = await contentHash(root, nodeFiles);
  const workerFiles = ["backends/workers/package.json", "backends/workers/package-lock.json", "backends/workers/wrangler.test.jsonc", "backends/workers/codemode/wrangler.jsonc", "tests/contract/fixtures/workers.ts"];
  for (const directory of ["backends/workers/src", "backends/workers/test", "backends/workers/codemode", "backends/workers/scripts", "backends/workers/computers"]) workerFiles.push(...await walk(root, directory));
  // Bundler configuration can affect the executed Worker, too.
  if (await stat(path.join(root, "backends/workers/tsconfig.json")).catch(() => null)) workerFiles.push("backends/workers/tsconfig.json");
  const workerKey = await contentHash(root, workerFiles);
  return { nodeKey, suiteHash: createHash("sha256").update(nodeKey).update(workerKey).digest("hex"),
    ...(details ? { nodeFiles: [...nodeFiles].sort(), workerFiles: [...new Set(workerFiles)].sort() } : {}) };
}

export function selectCases(inventory, { area, group, files } = {}) {
  if (group && !Object.hasOwn(groups, group)) throw new Error(`Unknown group ${group}; choose ${Object.keys(groups).join(", ")}`);
  const areas = area?.split(",");
  const fileList = files?.split(",");
  return inventory.filter(row => (!areas || areas.includes(row.area)) && (!group || groupFor(row) === group)
    && (!fileList || fileList.includes(row.file) || fileList.includes(row.file?.split("/").at(-1))));
}

export function partitionFiles(manifest, total, durations = []) {
  if (!Number.isInteger(total) || total < 1 || total > 40) throw new Error("Shard count must be from 1 to 40");
  const measured = new Map(durations.map(row => [caseKey(row), row.durationMs]));
  const weights = new Map();
  for (const row of manifest) if (row.file !== "scope") weights.set(row.file, (weights.get(row.file) ?? 0) + (measured.get(caseKey(row)) || 1000));
  const shards = Array.from({ length: total }, () => ({ files: [], durationMs: 0 }));
  for (const [file, durationMs] of [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const shard = shards.reduce((best, value) => value.durationMs < best.durationMs ? value : best);
    shard.files.push(file); shard.durationMs += durationMs;
  }
  return shards.map(shard => shard.files.sort());
}

export function greenFor(report, manifest, nodeKey) {
  if (report?.backend !== "node" || report.nodeKey !== nodeKey || !Array.isArray(report.rows)) return false;
  const rows = new Map(report.rows.map(row => [caseKey(row), row]));
  if (rows.size !== report.rows.length || report.rows.some(row => row.status === "fail")) return false;
  return manifest.every(row => rows.get(caseKey(row))?.status === (row.status === "out-of-scope" ? "out-of-scope" : "pass"));
}

export const baselineDirectories = root => [path.join(root, "backends/workers/measurements/node-baselines"), path.join(process.env.CONTRACT_CACHE_DIR ?? path.join(homedir(), "rt-cache/contract"), "node-baselines")];

export async function loadBaseline(root, nodeKey, manifest) {
  for (const directory of baselineDirectories(root)) {
    const filename = path.join(directory, `${nodeKey}.json`);
    const report = await readFile(filename, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (greenFor(report, manifest, nodeKey)) return { report, filename };
  }
  return null;
}

export async function saveBaseline(root, report) {
  if (report.backend !== "node" || report.rows.some(row => !["pass", "out-of-scope"].includes(row.status))) return;
  const directories = baselineDirectories(root);
  // Local merges publish the repo cache. Only pool jobs also maintain ~/rt-cache.
  for (const directory of process.env.CONTRACT_ON_SPRITE === "1" || process.env.CONTRACT_CACHE_DIR ? directories : directories.slice(0, 1)) {
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, `${report.nodeKey}.json`);
    const previous = await readFile(filename, "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const rows = new Map(previous?.nodeKey === report.nodeKey ? previous.rows.map(row => [caseKey(row), row]) : []);
    for (const row of report.rows) rows.set(caseKey(row), row);
    const merged = { ...report, area: "cached", expectedCases: rows.size, rows: [...rows.values()].sort((a, b) => caseKey(a).localeCompare(caseKey(b))) };
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(merged, null, 2) + "\n");
    await rename(temporary, filename);
  }
}

export function mergeReports(reports, manifest, { backend, nodeKey, suiteHash }) {
  if (!reports.length) throw new Error(`No ${backend} shard reports found`);
  const rows = [], seen = new Set(), expected = new Set(manifest.map(caseKey));
  const shardIds = new Set();
  for (const report of reports) {
    if (report.backend !== backend || report.nodeKey !== nodeKey || report.suiteHash !== suiteHash) throw new Error(`Cannot merge ${backend} reports from different source inputs`);
    if (!report.shard || !Number.isInteger(report.shard.index) || report.shard.index < 1 || report.shard.index > report.shard.total || shardIds.has(report.shard.index)) throw new Error("Missing, invalid or duplicate shard identity");
    shardIds.add(report.shard.index);
    if (report.expectedCases !== report.rows.filter(row => row.area !== "harness").length) throw new Error("Shard report has an incomplete inventory");
    for (const row of report.rows) {
      const id = caseKey(row);
      if (seen.has(id)) throw new Error(`Duplicate shard case: ${row.name}`);
      if (!expected.has(id) && row.area !== "harness") throw new Error(`Unexpected shard case: ${row.name}`);
      seen.add(id); rows.push(row);
    }
  }
  const total = reports[0].shard.total;
  if (shardIds.size !== total || reports.some(report => report.shard.total !== total)) throw new Error(`Expected ${total} shard reports, received ${shardIds.size}`);
  for (const row of manifest) if (!seen.has(caseKey(row))) throw new Error(`Missing shard case: ${row.name}`);
  rows.sort((a, b) => caseKey(a).localeCompare(caseKey(b)));
  return { ...reports[0], shard: undefined, recordedAt: reports.map(report => report.recordedAt).sort().at(-1), expectedCases: manifest.length, durationMs: Math.max(...reports.map(report => report.durationMs ?? 0)), shards: reports.map(report => ({ ...report.shard, durationMs: report.durationMs })).sort((a, b) => a.index - b.index), rows };
}
