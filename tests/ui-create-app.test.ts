import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.match(await readFile(join(root, 'web/app/api/agent/route.ts'), 'utf8'), /existingAgent: e.AGENT_ID/);
  const config = JSON.parse(await readFile(join(root, 'web/wrangler.jsonc'), 'utf8'));
  assert.equal(config.services[0].service, 'web');
  assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  assert.match(await readFile(join(root, 'web/lib/env.ts'), 'utf8'), /getCloudflareContext/);
  assert.match(await readFile(join(root, 'web/next.config.ts'), 'utf8'), /outputFileTracingRoot: root, turbopack: \{ root \}/);
});
