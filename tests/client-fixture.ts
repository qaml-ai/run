// The ClientSessions fixture the client tests share: a runtime's /clients routes and a supervisor, in this process.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { getRequestListener } from "@hono/node-server";
import { ClientSessions } from "../src/client-sessions.ts";
import { BusyAgents } from "../src/busy-agents.ts";
import { Ownership } from "../src/ownership.ts";
import { applicationTools } from "../src/mcp-results.ts";
import { readJson } from "../src/http.ts";
import { FRAME_BYTES } from "../shared/client-protocol.ts";
import { configuredModel } from "../src/model.ts";
import { AgentClient, AgentRuntime, tool, schema, type AgentOptions, type RuntimeOptions, type Tool } from "../clients/node.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

export const token = "fixture-operator-secret-32-characters";
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: { timeout?: number; eventBytes?: number; idleMs?: number; maxAgents?: number; perTenant?: number; ttlMs?: number; maxWatchers?: number; maxNodeWatchers?: number; maxTenantWatchers?: number; busyLimit?: number; releaseDelayMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "camelai-sse-test-"));
  const { db } = await testDatabase();
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, maxAgents: options.maxAgents });
  // Busy agents counted against `busyLimit`, under this node's heartbeat; `releaseDelayMs` slows each release, as a loaded database does.
  let busyAgents: BusyAgents | undefined, ownership: Ownership | undefined;
  if (options.busyLimit !== undefined) {
    ownership = new Ownership(db, { node: "http://fixture", ttlMs: 30_000 });
    await ownership.start();
    busyAgents = new BusyAgents({ db, ownership, limitFor: async () => ({ limit: options.busyLimit!, source: "tenant" }) });
    const release = busyAgents.release.bind(busyAgents);
    if (options.releaseDelayMs) busyAgents.release = async agent => { await sleep(options.releaseDelayMs!); await release(agent); };
  }
  let sessions = new ClientSessions(supervisor, { db, root: join(root, "sessions"), secret: token, apiKeyFor: () => "fixture-only", toolTimeoutMs: options.timeout ?? 3000, eventBytes: options.eventBytes, idleMs: options.idleMs, maxAgentsPerTenant: options.perTenant, ttlMs: options.ttlMs, maxWatchers: options.maxWatchers, maxNodeWatchers: options.maxNodeWatchers, maxTenantWatchers: options.maxTenantWatchers, busyAgents });
  let model = configuredModel();
  const server = createServer(getRequestListener(async (req, env) => {
    if (new URL(req.url).pathname.startsWith("/clients/")) return sessions.app.fetch(req, env);
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    try {
      const body = await readJson(req.body, FRAME_BYTES);
      const tools = applicationTools(body);
      const result = await sessions.create(tools, { model, ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}) }, req.headers.get("idempotency-key") ?? undefined, { name: body.name, type: body.type }, "default");
      return Response.json(result, { status: 201 });
    } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: AgentClient[] = [];
  t.after(async () => {
    // Teardown is not a deploy: clients are cut off, never waiting for a call left running.
    await Promise.all(clients.map(client => client.close({ drainMs: 0 })));
    await sessions.close();
    await supervisor.close();
    await ownership?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const runtimeOptions = { url, apiKey: token };
  async function start(tools: AgentOptions["tools"] = {}, extra: Partial<AgentOptions> = {}, config: Partial<RuntimeOptions> = {}) {
    const runtime = new AgentRuntime({ ...runtimeOptions, ...config });
    const agent = await runtime.createAgent({ tools, ...extra });
    clients.push(agent);
    // A created agent starts in the background: these tests reach into its host, so wait until it answers.
    await until(() => supervisor.request(agent.session.id, "status").then(() => true, () => false), "the agent to start");
    return agent;
  }
  async function post(agent: AgentClient, suffix: string, body: unknown) {
    return fetch(url + `/clients/${agent.session.id}${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${agent.session.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  return {
    root, supervisor, url, runtimeOptions, start, post, clients,
    db,
    header: async (id: string) => (await db.query("select header from agents where id = $1", [id])).rows[0]?.header,
    get sessions() { return sessions; },
    setModel(chosen: Model<Api>) { model = chosen; },
    async restartHost() {
      await sessions.close();
      await supervisor.close();
      sessions = new ClientSessions(supervisor, { db, root: join(root, "sessions"), secret: token, apiKeyFor: () => "fixture-only" });
    },
  };
}
export const echo = (execute: Tool<{ value: string }>["execute"]) => tool({
  description: "Fixture client tool", input: schema.Object({ value: schema.String() }, { additionalProperties: false }), execute,
});
