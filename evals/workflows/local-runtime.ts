// A local Workers runtime for workflow evals: the Workers app of a checkout (default: this one) with workflows on, real
// models, and native computers on local Docker. It derives a config from
// backends/workers/wrangler.computers.test.jsonc into backends/workers/.wrangler/evals/
// (gitignored), with:
// - vars: real models (TEST_MODEL off, camelrun/default) and AGENT_WORKFLOW_TENANTS for the local tenant;
// - a throwaway .dev.vars (a random AGENT_SECRETS_KEY, so the tenant can store a provider key);
// Then it starts Postgres (scripts/local-postgres.mjs), `wrangler dev`, and stores OPENROUTER_API_KEY from the
// environment on the local tenant (never on a command line or in a file). It prints the URL and token and keeps running.
//
//   OPENROUTER_API_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning evals/workflows/local-runtime.ts [--checkout <dir>] [--port 8788]
//   node … evals/workflows/local-runtime.ts --stop [--checkout <dir>]     (removes the database, the key in it, and the local Durable Object state)
//
// Point --checkout at a worktree nobody edits during the evals: wrangler dev reloads on changes in its checkout, which
// resets every Durable Object mid-run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO } from "./lib/score.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const checkout = resolve(arg("checkout") ?? REPO), workers = join(checkout, "backends/workers"), out = join(workers, ".wrangler/evals");
export const LOCAL_TOKEN = "local-integration-only-token-with-at-least-32-characters";

if (argv.includes("--stop")) {
  spawnSync(process.execPath, ["scripts/local-postgres.mjs", "--stop"], { cwd: workers, stdio: "inherit" });
  // The Durable Objects' local storage too: every agent, workflow and computer the runs made. Kept, deleted agents'
  // alarms go on firing ("Agent deleted") in the next runtime, thousands an hour after a few batches, until it stalls.
  rmSync(join(out, ".wrangler", "state"), { recursive: true, force: true });
  process.exit(0);
}
if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY: it is stored on the local tenant through the API");
mkdirSync(out, { recursive: true });

// Wrangler's JSONC: comments and trailing commas out, then JSON.
const jsonc = (text: string) => JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, string) => string ?? "").replace(/,(\s*[}\]])/g, "$1"));
const config = jsonc(readFileSync(join(workers, "wrangler.computers.test.jsonc"), "utf8"));
config.main = join(workers, config.main);
config.vars = { ...config.vars, TEST_MODEL: "0", MODEL: "camelrun/default", AGENT_WORKFLOW_TENANTS: "camelrun-proto-local" };
delete config.vars.TEST_HOOKS;
for (const container of config.containers ?? []) for (const image of Object.values(container.images ?? {}) as { dockerfile?: string }[]) image.dockerfile = join(workers, "computers/Dockerfile");
if (config.assets?.directory) config.assets.directory = join(workers, config.assets.directory);
writeFileSync(join(out, "wrangler.jsonc"), JSON.stringify(config, null, 2));
if (!existsSync(join(out, ".dev.vars"))) writeFileSync(join(out, ".dev.vars"), `AGENT_SECRETS_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });

const pg = spawnSync(process.execPath, ["scripts/local-postgres.mjs"], { cwd: workers, encoding: "utf8" });
if (pg.status !== 0) throw new Error(`local Postgres: ${pg.stderr.slice(0, 500)}`);
const port = arg("port") ?? "8788";
const dev = spawn(join(workers, "node_modules/.bin/wrangler"), ["dev", "--local", "--port", port, "-c", join(out, "wrangler.jsonc"), "-c", join(workers, "codemode/wrangler.jsonc")],
  { cwd: out, env: { ...process.env, WRANGLER_LOG_PATH: join(out, "logs") }, stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
const onLine = async (chunk: Buffer) => {
  process.stdout.write(chunk);
  if (ready || !/Ready on/.test(chunk.toString())) return;
  ready = true;
  const url = `http://127.0.0.1:${port}`;
  const stored = await fetch(`${url}/v1/providers/openrouter/key`, { method: "PUT", headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ apiKey: process.env.OPENROUTER_API_KEY }) });
  console.log(`\nwf-evals local runtime: AGENT_URL=${url} AGENT_RUNTIME_TOKEN=${LOCAL_TOKEN} (the local fixture token); OpenRouter key stored: ${stored.status}`);
};
dev.stdout.on("data", onLine);
dev.stderr.on("data", chunk => process.stderr.write(chunk));
dev.on("exit", code => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => dev.kill(signal));
