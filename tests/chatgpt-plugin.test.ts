import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { validate } from "../plugins/chatgpt/build.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_PASSWORD, lastUser, runtime } from "./runtime-server.ts";

test("the ChatGPT plugin package meets the schemas and the directory's limits", () => {
  const { errors } = validate();
  assert.deepEqual(errors, []);
});

for (const split of [false, true]) test(`the plugin's path works end to end${split ? ", with the issuer on another origin than the MCP endpoint and sign-in pages" : ""}: discovery, registration, email and password sign-in, consent, /v1/me, the review cases' tools, refresh, revocation`, async t => {
  // The public URL is where the runtime listens, so the metadata's URLs are reachable: a free port, chosen first.
  // Split, the issuer is an alias (localhost) of it, as agents.camelai.dev is of run.camelai.com.
  // Another process can take the port between the probe and the runtime's listen (EADDRINUSE): then another port.
  const start = async (): Promise<Awaited<ReturnType<typeof runtime>>> => {
    const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
    const alias = `http://localhost:${port}`;
    return runtime(t, body => ({ role: "assistant", content: `echo ${lastUser(body)}` }), {
      PORT: String(port), AGENT_PUBLIC_URL: `http://127.0.0.1:${port}`, ...(split ? { AGENT_PUBLIC_ALIASES: alias, AGENT_ISSUER: alias } : {}),
    });
  };
  const r = await start().catch(error => /Server exited/.test(String(error)) ? start() : Promise.reject(error));
  // The reviewer's account: an email and password the operator set, as `infra/tenant.sh set-password` does.
  const password = join(r.root, "reviewer-password");
  writeFileSync(password, `${TEST_PASSWORD}\n`, { mode: 0o600 });
  assert.equal((await r.call("/v1/tenants/alice/password", { method: "PUT", body: { email: "reviewer@example.test", password: TEST_PASSWORD } })).status, 200);
  // Not spawnSync: the fake model answers from this process.
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "plugins/chatgpt/e2e.ts", r.base],
    { env: { ...process.env, CAMELRUN_EMAIL: "reviewer@example.test", CAMELRUN_PASSWORD_FILE: password } });
  if (split) assert.match(stdout, new RegExp(`issuer ${r.base.replace("127.0.0.1", "localhost")}, pages on ${r.base}`));
  assert.match(stdout, /sign-in with an email and password, and consent/);
  assert.match(stdout, /\/v1\/me with the access token: account alice, via oauth/);
  assert.doesNotMatch(stdout, new RegExp(TEST_PASSWORD), "the password is never printed");
  assert.match(stdout, /run_agent: "echo Write about autumn\."/);
  assert.match(stdout, /its access token now gets 401\nok\n$/);
  assert.deepEqual((await r.call("/v1/agents")).json, [], "everything it made is deleted");
});
