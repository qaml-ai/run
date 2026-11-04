// Real local workerd validation. No cloud API calls or model providers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runBench } from "./codemode-run.mjs";

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const token = `local-benchmark-only-${crypto.randomUUID()}`;
const state = await mkdtemp(join(tmpdir(), "camelrun-codemode-"));
// Wrangler 4.157's local __mf_do_wrapper_entry.js interpolates exported class
// names as identifiers. Cloudflare accepts the actual string-named exports.
// Adapt only temporary local copies; never deploy these test copies.
const local = await mkdtemp(join(directory, "bench/codemode-local-"));
for (const name of ["caller", "sandbox"]) {
  const filename = name === "caller" ? "codemode-worker.ts" : "codemode-sandbox.ts";
  const source = (await readFile(join(directory, "bench", filename), "utf8"))
    .replace('as "camelrun-proto-codemode-caller"', "as CamelrunProtoCodemodeCaller")
    .replace('as "camelrun-proto-codemode-sandbox"', "as CamelrunProtoCodemodeSandbox")
    .replace('"../src/validation.ts"', JSON.stringify(join(directory, "src/validation.ts")));
  await writeFile(join(local, filename), source);
  const config = JSON.parse(await readFile(join(directory, "bench", `codemode-${name}.wrangler.jsonc`), "utf8"));
  delete config.account_id;
  for (const binding of config.durable_objects.bindings) {
    binding.class_name = binding.class_name === "camelrun-proto-codemode-caller" ? "CamelrunProtoCodemodeCaller" : "CamelrunProtoCodemodeSandbox";
  }
  config.migrations[0].new_sqlite_classes = config.migrations[0].new_sqlite_classes.map(value =>
    value === "camelrun-proto-codemode-caller" ? "CamelrunProtoCodemodeCaller" : "CamelrunProtoCodemodeSandbox");
  await writeFile(join(local, `codemode-${name}.json`), JSON.stringify(config));
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(state, "logs") };
for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) delete env[key];
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--local",
  "--config", join(local, "codemode-caller.json"), "--config", join(local, "codemode-sandbox.json"),
  "--ip", "127.0.0.1", "--port", String(port), "--persist-to", state, "--var", `API_TOKEN:${token}`,
], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let output = "";
const capture = value => { output = (output + value).slice(-16000); };
child.stdout.on("data", capture);
child.stderr.on("data", capture);
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Local workerd exited before readiness");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  assert.equal(ready, true, "Local workerd became ready");
  const result = await runBench({ url: `http://127.0.0.1:${port}`, token, samples: 2, concurrency: 50 });
  assert.ok(Object.values(result.authentication).every(status => status === 401));
  assert.equal(result.measurements.cold.successful, 2);
  assert.equal(result.measurements.warm.successful, 2);
  assert.equal(result.measurements.nested.successful, 2);
  assert.ok(result.raw.nested.every(row => row.data.result.value === 20));
  for (const batch of result.measurements.batches) assert.equal(batch.summary.successful, 50, batch.layout);
  for (const row of result.measurements.safety) {
    assert.ok(row.failedAsExpected, `${row.case}: expected script error`);
    assert.ok(row.callerInstancePreserved, `${row.case}: caller instance survived`);
    assert.ok(row.recovered, `${row.case}: successful following execution`);
  }
  console.log(JSON.stringify({ validation: "passed",
    limitation: "Temporary local class aliases; same-process Wrangler scheduling does not validate cloud caller responsiveness.",
    measurements: result.measurements }, null, 2));
} catch (error) {
  console.error(output.replaceAll(token, "[redacted]"));
  throw error;
} finally {
  const stopped = once(child, "exit");
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([stopped, delay(1000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await rm(state, { recursive: true, force: true });
  await rm(local, { recursive: true, force: true });
}
