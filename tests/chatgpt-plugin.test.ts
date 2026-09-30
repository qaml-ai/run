import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { validate } from "../plugins/chatgpt/build.ts";
import { OPERATOR, lastUser, runtime } from "./runtime-server.ts";

test("the ChatGPT plugin package meets the schemas and the directory's limits", () => {
  const { errors } = validate();
  assert.deepEqual(errors, []);
});

test("the plugin's path works end to end: discovery, registration, token sign-in, consent, the review cases' tools, refresh, revocation", async t => {
  // The public URL is where the runtime listens, so the metadata's URLs are reachable: a free port, chosen first.
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const r = await runtime(t, body => ({ role: "assistant", content: `echo ${lastUser(body)}` }), { PORT: String(port), AGENT_PUBLIC_URL: `http://127.0.0.1:${port}` });
  // Not spawnSync: the fake model answers from this process.
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "plugins/chatgpt/e2e.ts", r.base], { env: { ...process.env, CAMELRUN_TOKEN: OPERATOR } });
  assert.match(stdout, /run_agent: "echo Write about autumn\."/);
  assert.match(stdout, /its access token now gets 401\nok\n$/);
  assert.deepEqual((await r.call("/v1/agents")).json, [], "everything it made is deleted");
});
