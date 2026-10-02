#!/usr/bin/env node
/**
 * npm create @camelai/run-app [directory] [--api-key <key>] [--base-url <url>] [--no-install]
 *
 * Copies the Next.js starter into `directory` (default: agent-app), with an AGENTS.md (and CLAUDE.md) for coding agents,
 * writes .env.local with the API key (from --api-key or CAMELAI_API_KEY) and installs its dependencies with the
 * package manager it was run with.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

function parse(argv) {
  const options = { directory: undefined, apiKey: process.env.CAMELAI_API_KEY, baseUrl: process.env.CAMELAI_BASE_URL, install: true, help: false };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    const value = () => { const next = argv[++at]; if (next === undefined) fail(`${arg} needs a value`); return next; };
    if (arg === "--api-key") options.apiKey = value();
    else if (arg.startsWith("--api-key=")) options.apiKey = arg.slice(10);
    else if (arg === "--base-url") options.baseUrl = value();
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice(11);
    else if (arg === "--no-install") options.install = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("-")) fail(`Unknown option ${arg}`);
    else if (options.directory === undefined) options.directory = arg;
    else fail(`Unexpected argument ${arg}`);
  }
  return options;
}
function fail(message) { console.error(`create-run-app: ${message}`); process.exit(1); }

const options = parse(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: npm create @camelai/run-app [directory] [-- options]

Creates a Next.js app with a streaming chat to an agent on camelRun, in directory (default: agent-app).

Options:
  --api-key <key>   the API key to write to .env.local (default: CAMELAI_API_KEY). Prefer the environment
                    variable: a key on the command line lands in your shell history
  --base-url <url>  a self-hosted runtime (default: CAMELAI_BASE_URL, else https://run.camelai.com)
  --no-install      skip installing dependencies
  -h, --help        show this

Create a key at https://run.camelai.com/console/tokens.`);
  process.exit(0);
}
const target = resolve(options.directory ?? "agent-app");
if (existsSync(target) && readdirSync(target).length) fail(`${target} is not empty`);
const name = basename(target).toLowerCase().replace(/[^a-z0-9-_.]/g, "-").replace(/^[-_.]+/, "") || "agent-app";

cpSync(join(here, "template"), target, { recursive: true });
renameSync(join(target, "_gitignore"), join(target, ".gitignore"));
const manifest = join(target, "package.json");
writeFileSync(manifest, readFileSync(manifest, "utf8").replaceAll("{{version}}", version).replace('"name": "agent-app"', `"name": "${name}"`));
const env = [`CAMELAI_API_KEY=${options.apiKey ?? ""}`, ...(options.baseUrl ? [`CAMELAI_BASE_URL=${options.baseUrl}`] : [])].join("\n");
writeFileSync(join(target, ".env.local"), `${env}\n`, { mode: 0o600 });

const agent = process.env.npm_config_user_agent ?? "";
const manager = agent.startsWith("pnpm") ? "pnpm" : agent.startsWith("yarn") ? "yarn" : agent.startsWith("bun") ? "bun" : "npm";
if (options.install) {
  console.log(`Installing dependencies with ${manager}…`);
  const result = spawnSync(manager, ["install"], { cwd: target, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) console.warn(`${manager} install failed; run it yourself in ${target}`);
}
const relative = options.directory ?? "agent-app";
console.log(`
Created ${relative}.

  cd ${relative}${options.install ? "" : `\n  ${manager} install`}${options.apiKey ? "" : "\n  # add CAMELAI_API_KEY to .env.local (create one at https://run.camelai.com/console/tokens)"}
  ${manager === "npm" ? "npm run" : manager} dev

Then open http://localhost:3000. Coding agents: see AGENTS.md.`);
