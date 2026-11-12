// The client half of the bench, from ANOTHER machine: clone/fetch/push against a gitsvc that bench/bench.ts left
// serving (SERVE_MINUTES). Env: GITSVC_URL, GITSVC_KEY, BENCH_SIZES.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken } from "../src/token.ts";
import { git } from "../src/gitexec.ts";
import { SIZES, content, pathOf } from "./trees.ts";

const base = process.env.GITSVC_URL!.replace(/\/$/, ""), KEY = process.env.GITSVC_KEY!;
const sizes = (process.env.BENCH_SIZES ?? "small,medium,large").split(",");
const root = await mkdtemp(join(tmpdir(), "gitsvc-client-"));
const tok = (repo: string, scope: "read" | "write" | "admin") => mintToken(KEY, { repo, scope, exp: Date.now() / 1000 + 3600 });
const auth = (t: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${t}` });
const ident = ["-c", "user.email=bench@example.com", "-c", "user.name=bench"];
async function timed(fn: () => Promise<unknown>) { const t = performance.now(); await fn(); return Math.round(performance.now() - t); }
async function median(n: number, fn: () => Promise<unknown>) { const s: number[] = []; for (let i = 0; i < n; i++) s.push(await timed(fn)); return s.sort((a, b) => a - b)[Math.floor(n / 2)]; }
async function api(repo: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api/repos${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok(repo, "admin")}`, "content-type": "application/json" } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r;
}
const head = async (repo: string) => ((await (await api(repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
const b64 = (s: string) => Buffer.from(s).toString("base64");

const results: Record<string, Record<string, number>> = {};
for (const size of sizes) {
  const repo = `bench-${size}`, { bytesPerFile } = SIZES[size];
  const remote = `${base}/${repo}.git`, readEnv = auth(tok(repo, "read")), work = join(root, size);
  const row: Record<string, number> = {};
  results[size] = row;
  row.api_rtt_ms = await median(9, () => head(repo));
  row.ls_remote_ms = await median(5, () => git(["ls-remote", remote, "refs/heads/main"], { env: readEnv }));
  row.clone_full_cold_ms = await timed(() => git(["-c", "protocol.version=2", "clone", "-q", remote, join(work, "clone")], { env: readEnv }));
  row.clone_blobless_nocheckout_ms = await timed(() => git(["clone", "-q", "--filter=blob:none", "--no-checkout", remote, join(work, "blobless")], { env: readEnv }));
  row.mirror_cold_ms = await timed(() => git(["clone", "-q", "--mirror", remote, join(work, "mirror.git")], { env: readEnv }));
  await api(repo, `/${repo}/commit`, { branch: "main", parent: await head(repo), message: "3 files from client", files: Object.fromEntries([0, 1, 2].map((i) => [pathOf(i), b64(content(i + 900_000 + Date.now() % 1000, bytesPerFile))])) });
  row.fetch_reset_warm_ms = await timed(async () => { await git(["-C", join(work, "clone"), "fetch", "-q", "origin", "main"], { env: readEnv }); await git(["-C", join(work, "clone"), "reset", "-q", "--hard", "FETCH_HEAD"]); });
  row.mirror_fetch_warm_ms = await timed(() => git(["-C", join(work, "mirror.git"), "fetch", "-q", "origin"], { env: readEnv }));
  row.job_from_mirror_ms = await timed(() => git(["clone", "-q", "--shared", "--branch", "main", join(work, "mirror.git"), join(work, "job")]));
  let n = 0;
  const clone = join(work, "clone");
  row.push_1file_cli_ms = await median(5, async () => {
    await writeFile(join(clone, pathOf(3)), content(800_000 + n++, bytesPerFile));
    await git(["-C", clone, ...ident, "commit", "-qam", "one"]);
    await git(["-C", clone, "push", "-q", remote, "HEAD:refs/heads/client"], { env: auth(tok(repo, "write")) });
  });
  row.commit_1file_api_ms = await median(5, async () => api(repo, `/${repo}/commit`, { branch: "main", parent: await head(repo), message: "api", files: { [pathOf(10)]: b64(content(700_000 + n++, bytesPerFile)) } }));
  const sha = (await git(["-C", clone, "rev-parse", `HEAD:${pathOf(7)}`]));
  row.blob_read_ms = await median(9, () => fetch(`${base}/api/repos/${repo}/blob/${sha}`, { headers: { authorization: `Bearer ${tok(repo, "read")}` } }).then((r) => r.arrayBuffer()));
  let f = 0; const h = await head(repo);
  row.fork_ms = await median(5, () => api(repo, `/${repo}/refs`, { ref: `refs/heads/cfork/${Date.now()}-${f++}`, old: null, new: h }));
  console.error(size, JSON.stringify(row));
  await rm(work, { recursive: true, force: true });
}
const keys = [...new Set(Object.values(results).flatMap((r) => Object.keys(r)))];
console.log(`\nclient against ${new URL(base).host}\n`);
console.log(`| metric | ${sizes.join(" | ")} |\n|---|${sizes.map(() => "---:").join("|")}|`);
for (const key of keys) console.log(`| ${key} | ${sizes.map((s) => String(results[s]?.[key] ?? "")).join(" | ")} |`);
console.log(`\n${JSON.stringify(results)}`);
await rm(root, { recursive: true, force: true });
