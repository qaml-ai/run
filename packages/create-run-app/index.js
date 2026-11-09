#!/usr/bin/env node
/**
 * npm create @camelai/run-app [directory] [--api-key <key>] [--base-url <url>] [--no-install]
 *
 * Copies the Next.js starter into `directory` (default: agent-app), with an AGENTS.md (and CLAUDE.md) for coding agents,
 * writes .env.local with the API key (from --api-key or CAMELRUN_API_KEY) and installs its dependencies with the
 * package manager it was run with.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

function parse(argv) {
  const options = { directory: undefined, apiKey: process.env.CAMELRUN_API_KEY || process.env.CAMELAI_API_KEY, baseUrl: process.env.CAMELRUN_URL || process.env.CAMELAI_BASE_URL || process.env.CAMELAI_URL, install: true, cloudflare: false, help: false };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    const value = () => { const next = argv[++at]; if (next === undefined) fail(`${arg} needs a value`); return next; };
    if (arg === "--api-key") options.apiKey = value();
    else if (arg.startsWith("--api-key=")) options.apiKey = arg.slice(10);
    else if (arg === "--base-url") options.baseUrl = value();
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice(11);
    else if (arg === "--cloudflare") options.cloudflare = true;
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
  --api-key <key>   the API key to write to .env.local (default: CAMELRUN_API_KEY, then CAMELAI_API_KEY). Prefer the environment
                    variable: a key on the command line lands in your shell history
  --base-url <url>  a self-hosted runtime (default: CAMELRUN_URL, then CAMELAI_BASE_URL, else https://run.camelai.com)
  --cloudflare      configure OpenNext and Cloudflare Workers
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
if (options.cloudflare) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  Object.assign(pkg.scripts, { build: "next build --webpack", "build:worker": "opennextjs-cloudflare build", preview: "npm run build:worker && opennextjs-cloudflare preview", deploy: "npm run build:worker && opennextjs-cloudflare deploy", "cf:typegen": "wrangler types" });
  Object.assign(pkg.devDependencies, { "@opennextjs/cloudflare": "^1.20.0", wrangler: "^4.0.0" });
  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
  // A Worker cannot keep a local tool server attached after a response ends.
  writeFileSync(join(target, "app/api/agent/route.ts"), `import { agentKeyFor, createAgentHandler } from "@camelai/run/server";
import { authorize } from "@/lib/auth";
import { env } from "@/lib/env";
const handler = async () => {
  const e = await env();
  return createAgentHandler({
    apiKey: e.CAMELRUN_API_KEY || e.CAMELAI_API_KEY,
    url: e.CAMELRUN_URL || e.CAMELAI_BASE_URL || e.CAMELAI_URL,
    authorize: async (request, { thread }) => {
      const user = await authorize(request);
      return user ? { ...user, subject: user.userId, agentKey: await agentKeyFor(user.userId, thread) } : null;
    },
    agent: {
      ...(e.AGENT_DEFINITION ? { definition: e.AGENT_DEFINITION } : { instructions: "You are a helpful assistant." }),
      ...(e.AGENT_MODEL ? { model: e.AGENT_MODEL } : {}),
    },
    // To open an app-owned shared agent instead, replace agent above with:
    // existingAgent: "your-agent-id-or-key",
    // All admitted users then share its history. Enforce that access policy in authorize.
  });
};
let cached: ReturnType<typeof handler> | undefined;
export async function POST(request: Request) { cached ??= handler(); return (await cached)(request); }
`);
  writeFileSync(join(target, "app/components/chat.tsx"), `"use client";
import { AgentChat } from "@camelai/run-react/ui";
export function Chat() {
  return <AgentChat endpoint="/api/agent" suggestions={["Write a haiku about deploys", "Explain SSE in two sentences"]} style={{ flex: 1, minHeight: 0 }} />;
}
`);
  const nextConfig = join(target, "next.config.ts");
  writeFileSync(nextConfig, 'import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";\nif (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();\n' + readFileSync(nextConfig, "utf8"));
  writeFileSync(join(target, "open-next.config.ts"), 'import { defineCloudflareConfig } from "@opennextjs/cloudflare";\nexport default defineCloudflareConfig();\n');
  writeFileSync(join(target, "wrangler.jsonc"), JSON.stringify({ name, main: ".open-next/worker.js", compatibility_date: "2026-11-08", compatibility_flags: ["nodejs_compat"], assets: { directory: ".open-next/assets", binding: "ASSETS" }, services: [{ binding: "WORKER_SELF_REFERENCE", service: name }], observability: { enabled: true }, vars: { CAMELRUN_URL: options.baseUrl ?? "https://run.camelai.com" } }, null, 2) + "\n");
  writeFileSync(join(target, "lib/env.ts"), 'import { getCloudflareContext } from "@opennextjs/cloudflare";\nexport async function env(): Promise<Record<string, string | undefined>> {\n  const { env: bindings } = await getCloudflareContext({ async: true });\n  return { ...process.env, ...bindings } as Record<string, string | undefined>;\n}\n');
}
const env = [`CAMELRUN_API_KEY=${options.apiKey ?? ""}`, ...(options.baseUrl ? [`CAMELRUN_URL=${options.baseUrl}`] : [])].join("\n");
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

  cd ${relative}${options.install ? "" : `\n  ${manager} install`}${options.apiKey ? "" : "\n  # add CAMELRUN_API_KEY to .env.local (create one at https://run.camelai.com/console/tokens)"}
  ${manager === "npm" ? "npm run" : manager} dev

Then open http://localhost:3000. Coding agents: see AGENTS.md.`);
