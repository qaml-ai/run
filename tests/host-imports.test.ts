import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// An agent's host (agent-child.ts, in each agent process) reaches its journal, files and tools through its supervisor:
// it has no database and no server. What it imports is in every agent process's memory, so it loads neither.
test("an agent's host loads no Postgres driver, database or HTTP server code", () => {
  const script = `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.push(result.url); return result; } });
    await import(${JSON.stringify(new URL("../src/agent-host.ts", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../src/pi-durable/storage.ts", import.meta.url).href)});
    console.log(JSON.stringify(loaded));`;
  const loaded: string[] = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8" }));
  assert.ok(loaded.some(url => url.endsWith("/src/agent-host.ts")));
  assert.deepEqual(loaded.filter(url => /\/node_modules\/pg\/|\/src\/(db|http|ownership)\.ts$/.test(url)), []);
});
