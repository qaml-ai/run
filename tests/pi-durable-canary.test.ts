import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeConfig } from "../src/node-config.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";

const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as any;
const bridge = { definitions: [], call: async () => { throw new Error("No application tools"); } };

test("canary lists are exact operator IDs and leave the fleet default unchanged", () => {
  assert.equal(nodeConfig({}).engine, "pi-durable");
  const config = nodeConfig({ AGENT_ENGINE: "legacy", AGENT_PI_CANARY_AGENTS: " selected, other,selected, ", AGENT_PI_CANARY_TENANTS: " internal " });
  assert.equal(config.engine, "legacy");
  assert.deepEqual([...config.piCanaryAgents], ["selected", "other"]);
  assert.deepEqual([...config.piCanaryTenants], ["internal"]);
  assert.equal(config.piCanaryAgents.has("selected-prefix"), false);
  assert.equal(nodeConfig({}).piCanaryAgents.size, 0);
  assert.equal(nodeConfig({}).piCanaryTenants.size, 0);
});

for (const hosting of ["inline", "process"] as Hosting[]) test(`only the canary uses Pi across reopen; removing it rolls back (${hosting})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-canary-"));
  const supervisors: AgentSupervisor[] = [];
  t.after(async () => { await Promise.all(supervisors.map(s => s.close())); await rm(root, { recursive: true, force: true }); });
  const settings = nodeConfig({ AGENT_ENGINE: "legacy", AGENT_PI_CANARY_AGENTS: "selected", AGENT_PI_CANARY_TENANTS: "internal" });
  const open = () => {
    const supervisor = new AgentSupervisor(root, { hosting, engine: settings.engine,
      piCanaryAgents: settings.piCanaryAgents, piCanaryTenants: settings.piCanaryTenants });
    supervisors.push(supervisor); return supervisor;
  };
  const first = open();
  for (const [id, tenant, engine] of [["selected", "customer", "pi-durable"], ["tenant-selected", "internal", "pi-durable"],
    ["selected-prefix", "internal-prefix", "legacy"], ["ordinary", "customer", "legacy"]]) {
    const init = await first.start(id, { model, apiKey: "fixture", codeMode: false, tenant }, bridge);
    assert.equal(init.engine, engine, id);
  }
  await first.close();
  const second = open();
  assert.equal((await second.start("selected", { model, apiKey: "fixture", codeMode: false, tenant: "customer" }, bridge)).engine, "pi-durable");
  await second.close();
  settings.piCanaryAgents.clear();
  const rollback = open();
  assert.equal((await rollback.start("selected", { model, apiKey: "fixture", codeMode: false, tenant: "customer" }, bridge)).engine, "legacy");
});
