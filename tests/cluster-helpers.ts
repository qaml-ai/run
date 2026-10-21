import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { testDatabase } from "./database.ts";

export const token = "cluster-operator-token-at-least-24-chars";
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Whether `error` is a listen that found its port taken (EADDRINUSE), as Node says it or a node's stderr does. */
export const addressInUse = (error: unknown) => (error as { addressInUse?: boolean })?.addressInUse === true
  || (error as { code?: string })?.code === "EADDRINUSE" || /EADDRINUSE/.test(String(error));

/**
 * `use` on a port free a moment ago, again on another if something took it before `use` listened on it: a port
 * must be chosen before listening wherever its URL is configuration (AGENT_NODE_URL), so the race cannot be avoided.
 */
export async function onFreePort<T>(use: (port: number) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    try { return await use(port); } catch (error) { if (attempt >= attempts || !addressInUse(error)) throw error; }
  }
}

/** Runtime nodes sharing a database and storage (shared files here, S3 in production) with short heartbeats. */
export async function cluster(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agent-cluster-"));
  const { db, url: databaseUrl } = await testDatabase();
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { anthropic: "fixture-key", openrouter: "fixture-key" } } } }));
  const children: ChildProcess[] = [];
  const start = async (name: string, env: Record<string, string> = {}, fixedPort?: number): Promise<{ name: string; url: string; child: ChildProcess; logs: any[] }> => {
    return fixedPort !== undefined ? launch(name, env, fixedPort) : onFreePort(port => launch(name, env, port));
  };
  const launch = async (name: string, env: Record<string, string>, port: number) => {
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH, HOME: root, PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: url, AGENT_DATABASE_URL: databaseUrl,
        AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
        AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "cluster-session-secret-with-32-characters!", ...env,
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    const logs: any[] = [];
    let pendingErrors = "";
    child.stderr!.on("data", chunk => {
      errors = (errors + chunk).slice(-4096);
      process.stderr.write(chunk);
      pendingErrors += chunk;
      const lines = pendingErrors.split("\n");
      pendingErrors = lines.pop()!;
      for (const line of lines) { try { logs.push(JSON.parse(line)); } catch { /* not a log record */ } }
    });
    children.push(child);
    const ready = Promise.withResolvers<void>();
    let pending = "";
    child.stdout!.on("data", chunk => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) { try { logs.push(JSON.parse(line)); } catch { /* not a log record */ } }
      if (logs.some(entry => entry.type === "listening")) ready.resolve();
    });
    // On close, not exit: by then stderr is read to its end, so a listen error in it is seen.
    child.on("close", code => ready.reject(Object.assign(new Error(`node ${name} exited: ${code}`), { addressInUse: errors.includes("EADDRINUSE") })));
    await ready.promise;
    return { name, url, child, logs };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  /** Which node owns an actor, read straight from the database. */
  const owner = async (id: string) => (await db.query("select node from actor_owners where actor = $1", [id])).rows[0]?.node as string | undefined;
  /** The node that holds an actor now: its row names the node's live heartbeat. A node that fenced leaves its rows, held by no one. */
  const liveOwner = async (id: string) => (await db.query(`
    select o.node from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
    where o.actor = $1`, [id])).rows[0]?.node as string | undefined;
  return { start, owner, liveOwner, db, databaseUrl };
}

/**
 * A TCP proxy between a runtime node and Postgres that can fail the way a database
 * failover does: `reset` drops every connection and refuses new ones (a direct
 * connection to an instance that went away); `stall` holds traffic, old and new,
 * until the database is back (RDS Proxy queueing while the writer fails over).
 */
export async function databaseLink(target: URL) {
  const links = new Set<{ client: Socket; server?: Socket; held: { toServer: Buffer[]; toClient: Buffer[] } }>();
  let mode: "up" | "reset" | "stall" = "up";
  const attach = (link: { client: Socket; server?: Socket; held: { toServer: Buffer[]; toClient: Buffer[] } }) => {
    const server = link.server = createConnection({ host: target.hostname, port: Number(target.port) });
    server.on("data", chunk => { if (mode === "stall") link.held.toClient.push(chunk); else link.client.write(chunk); });
    server.on("error", () => link.client.destroy());
    server.on("close", () => { link.client.destroy(); links.delete(link); });
    for (const chunk of link.held.toServer.splice(0)) server.write(chunk);
  };
  const proxy: Server = createServer(client => {
    if (mode === "reset") { client.destroy(); return; }
    const link = { client, held: { toServer: [] as Buffer[], toClient: [] as Buffer[] } } as { client: Socket; server?: Socket; held: { toServer: Buffer[]; toClient: Buffer[] } };
    links.add(link);
    client.on("data", chunk => { if (mode === "stall" || !link.server) link.held.toServer.push(chunk); else link.server.write(chunk); });
    client.on("error", () => link.server?.destroy());
    client.on("close", () => { link.server?.destroy(); links.delete(link); });
    if (mode === "up") attach(link);
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const url = new URL(target);
  url.port = String((proxy.address() as { port: number }).port);
  return {
    url: url.toString(),
    down(how: "reset" | "stall") {
      mode = how;
      if (how === "reset") for (const link of links) { link.client.destroy(); link.server?.destroy(); }
    },
    up() {
      mode = "up";
      for (const link of links) {
        if (!link.server) attach(link);
        else { for (const chunk of link.held.toServer.splice(0)) link.server.write(chunk); for (const chunk of link.held.toClient.splice(0)) link.client.write(chunk); }
      }
    },
    close: () => { for (const link of links) { link.client.destroy(); link.server?.destroy(); } return new Promise(resolve => proxy.close(resolve)); },
  };
}

/**
 * A TCP forwarder in front of a node's port, which peers reach it by (its AGENT_NODE_URL). `cut` refuses every
 * connection, old and new, as a node partitioned from its peers looks to them; requests sent to the node's own
 * port still arrive (a model provider or a client the partition leaves reachable).
 */
export async function nodeLink(target: number) {
  const sockets = new Set<Socket>();
  const proxy: Server = createServer(client => {
    const server = createConnection({ host: "127.0.0.1", port: target });
    sockets.add(client).add(server);
    client.pipe(server).pipe(client);
    for (const socket of [client, server]) {
      socket.on("error", () => { client.destroy(); server.destroy(); });
      socket.on("close", () => { client.destroy(); server.destroy(); sockets.delete(socket); });
    }
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return {
    url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    cut: () => { proxy.close(); for (const socket of sockets) socket.destroy(); },
  };
}

export const lookup = (calls: string[]) => ({
  lookup: tool({
    description: "Look up a value", input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
    execute: ({ key }) => { calls.push(key); return `value-of-${key}`; },
  }),
});

/** An OpenAI-compatible model answering from `respond`; undefined leaves that call hanging, as if the node died mid-request. */
export async function fakeModel(t: { after(fn: () => Promise<void>): void }, respond: (body: any, index: number) => object | undefined | Promise<object | undefined>) {
  const bodies: any[] = [];
  const server = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const delta = await respond(body, bodies.length - 1) as any;
    if (!delta) return;
    // `{ status }`: the provider fails the request, as an overloaded one would.
    if (delta.status) return void res.writeHead(delta.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `fixture error ${delta.status}` } }));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
  return { bodies, env };
}
export const jsExec = (code: string) => ({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code }) } }] });
export const toolMessages = (body: any) => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  for (const started = Date.now(); !await check(); await sleep(50)) assert.ok(Date.now() - started < ms, what);
}

/** Stand-ins for what a task sees on ECS: container and task metadata, the ECS API, and the agent's task-protection endpoint. */
export async function fakeEcs(t: { after(fn: () => Promise<void>): void }) {
  const state = { revision: 1, created: Date.now() / 1000 - 60, running: 1, desired: 1, protection: [] as boolean[] };
  const task = { Cluster: "arn:aws:ecs:us-west-2:123456789012:cluster/runtime", Family: "runtime", Revision: "1", PullStartedAt: new Date().toISOString() };
  const server = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const json = (value: unknown, type = "application/json") => res.writeHead(200, { "Content-Type": type }).end(JSON.stringify(value));
    if (req.url === "/metadata") return json({ Networks: [{ NetworkMode: "awsvpc", IPv4Addresses: ["127.0.0.1"] }] });
    if (req.url === "/metadata/task") return json(task);
    if (req.url === "/agent/task-protection/v1/state") { state.protection.push(JSON.parse(text).ProtectionEnabled); return json({ protection: {} }); }
    assert.equal(req.headers["x-amz-target"], "AmazonEC2ContainerServiceV20141113.DescribeServices");
    json({ services: [{ serviceName: "runtime", deployments: [{ status: "PRIMARY", taskDefinition: `arn:aws:ecs:us-west-2:123456789012:task-definition/runtime:${state.revision}`, createdAt: state.created, runningCount: state.running, desiredCount: state.desired }] }], failures: [] }, "application/x-amz-json-1.1");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = {
    AGENT_NODE_URL: "", ECS_CONTAINER_METADATA_URI_V4: `${url}/metadata`, ECS_AGENT_URI: `${url}/agent`, AWS_ENDPOINT_URL_ECS: url,
    AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "fixture-secret", AGENT_ECS_SERVICE: "runtime",
    AGENT_ECS_POLL_MS: "200", AGENT_PROTECTION_IDLE_MS: "500",
  };
  return { state, env };
}

/**
 * A load balancer's view of the nodes, as the SDK's `fetch`: each request goes to the next node
 * that is up and not draining (a draining node fails its health check), so a reconnect finds another.
 * `frames` may rewrite or drop the event stream's frames, as a lossy connection would.
 */
export function balancer(nodes: { url: string; child: ChildProcess; logs: any[] }[], frames: (frame: string) => string | undefined = frame => frame) {
  let turn = 0;
  const streams = new Set<AbortController>();
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const up = nodes.filter(node => node.child.exitCode === null && !node.logs.some(entry => entry.type === "drain_started"));
    const url = new URL(String(input));
    const target = up[turn++ % up.length].url + url.pathname + url.search;
    if (!url.pathname.endsWith("/events")) return fetch(target, init);
    const stream = new AbortController();
    streams.add(stream);
    const response = await fetch(target, { ...init, signal: AbortSignal.any([stream.signal, ...(init.signal ? [init.signal] : [])]) });
    if (!response.body) return response;
    let buffer = "";
    const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
      transform(chunk, controller) {
        buffer += chunk;
        for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
          const frame = frames(buffer.slice(0, end));
          if (frame !== undefined) controller.enqueue(`${frame}\n\n`);
        }
      },
      flush() { streams.delete(stream); },
    })).pipeThrough(new TextEncoderStream());
    return new Response(body, { status: response.status, headers: response.headers });
  };
  /** Cut every open event stream, as a dropped connection would. */
  const drop = () => { for (const stream of streams) stream.abort(); streams.clear(); };
  return { fetch: fetcher, drop };
}
