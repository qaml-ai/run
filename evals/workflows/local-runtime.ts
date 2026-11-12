// A local Workers runtime for workflow evals: the Workers app of a checkout (default: this one) with workflows on, real
// models, and job() on local Docker containers, so evals never need the pilot. It derives a config from
// backends/workers/wrangler.computers.test.jsonc (the one the jobs e2e uses) into backends/workers/.wrangler/evals/
// (gitignored), with:
// - vars: real models (TEST_MODEL off, camelrun/default) and AGENT_WORKFLOW_TENANTS for the local tenant;
// - a throwaway .dev.vars (a random AGENT_SECRETS_KEY, so the tenant can store a provider key);
// - the job image: the computers Dockerfile plus the toolchains the tasks' jobs need (Go 1.27.3 for m-toml-go), since
//   job() has one image in phase 1. On the pilot the image is the deployed one: a task whose jobs need Go there waits
//   for an image per job (PR 8 follow-up) or uses `internet` to fetch it.
// Then it starts Postgres (scripts/local-postgres.mjs), `wrangler dev`, and stores OPENROUTER_API_KEY from the
// environment on the local tenant (never on a command line or in a file). It prints the URL and token and keeps running.
//
//   OPENROUTER_API_KEY=… node --experimental-strip-types --disable-warning=ExperimentalWarning evals/workflows/local-runtime.ts [--checkout <dir>] [--port 8788]
//   node … evals/workflows/local-runtime.ts --stop [--checkout <dir>]     (removes the database, and the key in it)
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO } from "./lib/score.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const checkout = resolve(arg("checkout") ?? REPO), workers = join(checkout, "backends/workers"), out = join(workers, ".wrangler/evals");
export const LOCAL_TOKEN = "local-integration-only-token-with-at-least-32-characters";
const GO = "1.27.3";

if (argv.includes("--stop")) {
  spawnSync(process.execPath, ["scripts/local-postgres.mjs", "--stop"], { cwd: workers, stdio: "inherit" });
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
for (const container of config.containers ?? []) for (const image of Object.values(container.images ?? {}) as { dockerfile?: string }[]) image.dockerfile = join(out, "Dockerfile");
if (config.assets?.directory) config.assets.directory = join(workers, config.assets.directory);
writeFileSync(join(out, "wrangler.jsonc"), JSON.stringify(config, null, 2));
copyFileSync(join(workers, "computers/parse.mjs"), join(out, "parse.mjs"));
const dockerfile = readFileSync(join(workers, "computers/Dockerfile"), "utf8").replace(/^CMD .*$/m, "");
writeFileSync(join(out, "Dockerfile"), `${dockerfile}
# Eval toolchains (local only): Go for m-toml-go's build jobs.
RUN curl -fsSL https://go.dev/dl/go${GO}.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local GOFLAGS=-mod=mod CGO_ENABLED=0
CMD ["sleep", "infinity"]
`);
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
