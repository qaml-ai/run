import { test } from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { agentKeyFor } from "../clients/handler.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/create-run-app/index.js", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../packages/create-run-app/package.json", import.meta.url), "utf8"));

test("create-run-app writes the starter, its key (readable only by its owner), and our packages at its version", async t => {
  const root = await mkdtemp(join(tmpdir(), "create-run-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = execFileSync(process.execPath, [cli, "My App", "--api-key", "key_123", "--base-url", "http://127.0.0.1:8790", "--no-install"], { cwd: root, encoding: "utf8", env: { ...process.env, CAMELAI_API_KEY: "" } });
  assert.match(out, /cd My App/);
  const app = join(root, "My App");
  for (const file of [".gitignore", ".env.example", "lib/auth.ts", "app/api/agent/route.ts", "app/components/chat.tsx", "app/layout.tsx", "README.md"]) assert.ok(existsSync(join(app, file)), file);
  assert.ok(!existsSync(join(app, "_gitignore")));
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  assert.equal(manifest.name, "my-app");
  assert.equal(manifest.dependencies["@camelai/run"], `^${version}`);
  assert.equal(manifest.dependencies["@camelai/run-react"], `^${version}`);
  assert.equal(await readFile(join(app, ".env.local"), "utf8"), "CAMELRUN_API_KEY=key_123\nCAMELRUN_URL=http://127.0.0.1:8790\n");
  assert.equal((await stat(join(app, ".env.local"))).mode & 0o777, 0o600);
  // The key never reaches the browser: only the route (server code) reads it.
  assert.doesNotMatch(await readFile(join(app, "app/components/chat.tsx"), "utf8"), /CAMELAI_API_KEY|NEXT_PUBLIC/);
  const route = await readFile(join(app, "app/api/agent/route.ts"), "utf8");
  assert.match(route, /authorize,/);
  assert.match(await readFile(join(app, "lib/auth.ts"), "utf8"), /if \(!await configured\(\)\) return null/);
  assert.ok(!existsSync(join(app, "proxy.ts")));
  // The agent gets the account's default model unless the app chooses one.
  assert.match(route, /\.\.\.\(e\.AGENT_MODEL \? \{ model: e\.AGENT_MODEL \} : \{\}\)/);
  assert.doesNotMatch(route, /model: "/);
  // Coding agents in the app read the installed SDK's docs; Claude Code's CLAUDE.md points at the same file.
  const agents = await readFile(join(app, "AGENTS.md"), "utf8");
  assert.match(agents, /<!-- BEGIN:camelrun-agent-rules -->[^]*node_modules\/@camelai\/run\/docs\/SKILL\.md[^]*<!-- END:camelrun-agent-rules -->/);
  assert.equal(await readFile(join(app, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  // A directory with something in it is left alone.
  assert.throws(() => execFileSync(process.execPath, [cli, "My App", "--no-install"], { cwd: root, stdio: "pipe" }), /not empty/);
});

test('Cloudflare generation uses runtime bindings and a standalone webpack root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'create-run-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [cli, 'web', '--cloudflare', '--no-install'], { cwd: root });
  const pkg = JSON.parse(await readFile(join(root, 'web/package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'next build --webpack');
  assert.doesNotMatch(await readFile(join(root, 'web/app/api/agent/route.ts'), 'utf8'), /get_weather/);
  assert.doesNotMatch(await readFile(join(root, 'web/app/api/agent/route.ts'), 'utf8'), /e\.AGENT_ID/);
  const config = JSON.parse(await readFile(join(root, 'web/wrangler.jsonc'), 'utf8'));
  assert.equal(config.services[0].service, 'web');
  assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  assert.match(await readFile(join(root, 'web/lib/env.ts'), 'utf8'), /getCloudflareContext/);
  assert.match(await readFile(join(root, 'web/next.config.ts'), 'utf8'), /outputFileTracingRoot: root, turbopack: \{ root \}/);
});

test("both generated routes share pending initialization; Cloudflare keeps users and threads separate", async t => {
  const root = await mkdtemp(join(tmpdir(), "create-run-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const cloudflare of [false, true]) {
    const app = join(root, cloudflare ? "worker" : "node");
    execFileSync(process.execPath, [cli, app, "--no-install", ...(cloudflare ? ["--cloudflare"] : [])]);
    const source = await readFile(join(app, "app/api/agent/route.ts"), "utf8");
    let resolveEnv!: (value: Record<string, string>) => void;
    const pendingEnv = new Promise<Record<string, string>>(resolve => { resolveEnv = resolve; });
    let reads = 0, creates = 0;
    let options: any;
    const mocks: Record<string, unknown> = {
      "@/lib/env": { env: () => { reads++; return pendingEnv; } },
      "@/lib/auth": { authorize: async (request: Request) => ({ userId: request.headers.get("user")! }) },
      "@camelai/run/server": { agentKeyFor, createAgentHandler: (value: unknown) => { creates++; options = value; return async () => new Response("ok"); } },
      "@camelai/run": { tool: (value: unknown) => value, schema: { Object: () => ({}), String: () => ({}) } },
    };
    const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
    const module = { exports: {} as any };
    runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => mocks[name], Response });
    const first = module.exports.POST(new Request("https://app.example"));
    const second = module.exports.POST(new Request("https://app.example"));
    assert.equal(reads, 1, "concurrent cold requests share the environment/handler promise");
    resolveEnv({ AGENT_DEFINITION: "def_example", AGENT_ID: "ignored_shared_agent" });
    await Promise.all([first, second]);
    assert.equal(creates, 1);
    if (cloudflare) {
      assert.equal(options.existingAgent, undefined);
      assert.equal(options.agent.definition, "def_example");
      const auth = (user: string, thread: string | null = null) => options.authorize(new Request("https://app.example", { headers: { user } }), { thread });
      const alice = await auth("alice"), bob = await auth("bob"), next = await auth("alice", "next");
      assert.equal(alice.agentKey, await agentKeyFor("alice"));
      assert.equal(new Set([alice.agentKey, bob.agentKey, next.agentKey]).size, 3);
    }
  }
});
