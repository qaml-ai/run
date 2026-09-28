import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../packages/create-agent-app/index.js", import.meta.url));
const { version } = JSON.parse(await readFile(new URL("../packages/create-agent-app/package.json", import.meta.url), "utf8"));

test("create-agent-app writes the starter, its key (readable only by its owner), and our packages at its version", async t => {
  const root = await mkdtemp(join(tmpdir(), "create-agent-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = execFileSync(process.execPath, [cli, "My App", "--api-key", "key_123", "--base-url", "http://127.0.0.1:8790", "--no-install"], { cwd: root, encoding: "utf8", env: { ...process.env, CAMELAI_API_KEY: "" } });
  assert.match(out, /cd My App/);
  const app = join(root, "My App");
  for (const file of [".gitignore", ".env.example", "proxy.ts", "app/api/agent/route.ts", "app/components/chat.tsx", "app/layout.tsx", "README.md"]) assert.ok(existsSync(join(app, file)), file);
  assert.ok(!existsSync(join(app, "_gitignore")));
  const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
  assert.equal(manifest.name, "my-app");
  assert.equal(manifest.dependencies["@camelai/agent-runtime"], `^${version}`);
  assert.equal(manifest.dependencies["@camelai/agent-runtime-react"], `^${version}`);
  assert.equal(await readFile(join(app, ".env.local"), "utf8"), "CAMELAI_API_KEY=key_123\nCAMELAI_BASE_URL=http://127.0.0.1:8790\n");
  assert.equal((await stat(join(app, ".env.local"))).mode & 0o777, 0o600);
  // The key never reaches the browser: only the route (server code) reads it.
  assert.doesNotMatch(await readFile(join(app, "app/components/chat.tsx"), "utf8"), /CAMELAI_API_KEY|NEXT_PUBLIC/);
  // Deployed, the demo sign-in lets nobody in unless the app opts in.
  const route = await readFile(join(app, "app/api/agent/route.ts"), "utf8");
  assert.match(route, /NODE_ENV === "production" && process\.env\.DEMO_AUTH !== "1"/);
  assert.match(await readFile(join(app, "proxy.ts"), "utf8"), /DEMO_AUTH !== "1"/);
  assert.match(await readFile(join(app, "README.md"), "utf8"), /Add your own sign-in before you deploy/);
  // A directory with something in it is left alone.
  assert.throws(() => execFileSync(process.execPath, [cli, "My App", "--no-install"], { cwd: root, stdio: "pipe" }), /not empty/);
});
