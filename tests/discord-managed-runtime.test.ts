import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { OPERATOR, OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";

const APP = "999000000000000001";
const BOT_TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2.GFixture.DiscordBotTokenSecretPart_abcdefXYZ0123";
const GUILDS = ["100000000000000001", "100000000000000002"];
const CHANNELS = ["200000000000000001", "200000000000000002"];
const USER = "300000000000000001";

test("managed bot runs isolated tenant agents through the real Gateway and console, and reconfigures existing conversations", async t => {
  const sent: { channel: string; content: string }[] = [];
  const left: string[] = [];
  const sockets = new Set<WebSocket>();
  let sequence = 0;
  let port = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, "http://localhost");
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    // The authorization code stands for the server the admin added Camel to.
    if (url.pathname === "/oauth2/token") return json(200, { access_token: "test-discord-user", expires_in: 3600, scope: "bot applications.commands identify", guild: { id: new URLSearchParams(raw).get("code") } });
    if (req.headers.authorization === "Bearer test-discord-user" && url.pathname === "/users/@me") return json(200, { id: USER });
    if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) return json(401, {});
    if (req.method === "DELETE" && url.pathname.startsWith("/users/@me/guilds/")) { left.push(url.pathname.split("/")[4]); return res.writeHead(204).end(); }
    if (url.pathname === "/users/@me") return json(200, { id: APP, username: "Camel", bot: true });
    if (url.pathname === "/gateway/bot") return json(200, { url: `ws://127.0.0.1:${port}`, shards: 1, session_start_limit: { remaining: 100 } });
    if (url.pathname.startsWith("/guilds/")) {
      const id = url.pathname.split("/")[2];
      const index = GUILDS.indexOf(id);
      if (index === -1) return json(404, {});
      if (url.pathname.endsWith("/channels")) return json(200, [{ id: CHANNELS[index], guild_id: id, name: "test", type: 0 }]);
      return json(200, { id, name: `Server ${index}` });
    }
    if (url.pathname.startsWith("/channels/")) {
      const channel = url.pathname.split("/")[2]; const index = CHANNELS.indexOf(channel);
      if (index === -1) return json(404, {});
      if (req.method === "GET") return json(200, { id: channel, guild_id: GUILDS[index], type: 0 });
      if (url.pathname.endsWith("/typing")) return res.writeHead(204).end();
      if (url.pathname.endsWith("/messages")) {
        const body = JSON.parse(raw); assert.deepEqual(body.allowed_mentions, { parse: [] });
        sent.push({ channel, content: body.content }); return json(200, { id: `${sent.length}` });
      }
    }
    return json(404, {});
  });
  const gateway = new WebSocketServer({ server });
  gateway.on("connection", socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", bytes => {
      const payload = JSON.parse(String(bytes));
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op === 2) socket.send(JSON.stringify({ op: 0, t: "READY", s: ++sequence, d: {
        user: { id: APP }, session_id: "fixture-session", resume_gateway_url: `ws://127.0.0.1:${port}`,
        guilds: GUILDS.map(id => ({ id, unavailable: false })),
      } }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); port = (server.address() as { port: number }).port;
  t.after(() => { for (const socket of gateway.clients) socket.terminate(); gateway.close(); server.closeAllConnections(); server.close(); });
  const r = await runtime(t, body => {
    const system = body.messages.find((message: any) => message.role === "system" || message.role === "developer")?.content;
    return { role: "assistant", content: String(system).includes("Beta-only") ? "Beta answer" : String(system).includes("Revised-only") ? "Revised answer" : "Alpha answer" };
  }, {
    AGENT_DISCORD_MANAGED_ENABLED: "true", AGENT_DISCORD_MANAGED_BOT_TOKEN: BOT_TOKEN,
    AGENT_DISCORD_MANAGED_APPLICATION_ID: APP, AGENT_DISCORD_MANAGED_CLIENT_SECRET: "fixture-client-secret",
    AGENT_DISCORD_API_URL: `http://127.0.0.1:${port}`,
  });
  const mention = (index: number, id: string, text: string) => {
    for (const socket of sockets) socket.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: ++sequence, d: {
      id, type: 0, guild_id: GUILDS[index], channel_id: CHANNELS[index], author: { id: USER, username: "tester", bot: false },
      mentions: [{ id: APP }], content: `<@${APP}> ${text}`, attachments: [],
    } }));
  };
  await until(() => r.logs.some(line => line.includes('"type":"discord_managed_gateway_ready"')), "managed Gateway ready");
  // Before anyone set it up through the console, a mention makes Camel leave the server, without a model call.
  mention(0, "400000000000000001", "hello before setup");
  await until(() => left.includes(GUILDS[0]), "Camel leaves a server nobody set up");
  assert.equal(sent.length, 0);
  assert.equal(r.model.bodies.length, 0);
  assert.equal((await r.db.query("select count(*)::int n from agents")).rows[0].n, 0);

  const headers: Record<string, string>[] = [];
  const bindings: any[] = [];
  for (let i = 0; i < 2; i++) {
    const token = i === 0 ? OPERATOR : OTHER_OPERATOR;
    const signIn = await fetch(`${r.base}/console/auth/token`, { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1" }, body: JSON.stringify({ token }) });
    const cookie = signIn.headers.getSetCookie().find(value => value.startsWith("ar_session="))!.split(";")[0];
    const h = { Cookie: cookie, "X-Agent-Runtime-Console": "1", "Content-Type": "application/json" }; headers.push(h);
    const install = await fetch(`${r.base}/console/discord/install`, { headers: h, redirect: "manual" });
    assert.equal(install.status, 302);
    const state = new URL(install.headers.get("location")!).searchParams.get("state");
    const callback = await fetch(`${r.base}/console/discord/callback?state=${state}&code=${GUILDS[i]}`, { headers: h, redirect: "manual" });
    assert.match(callback.headers.get("location")!, new RegExp(`discord_server=${GUILDS[i]}`));
    const definition = await r.call("/v1/definitions", { token, body: { name: i === 0 ? "Alpha" : "Beta", systemPrompt: i === 0 ? "Alpha-only" : "Beta-only", builtins: [] } });
    const response = await fetch(`${r.base}/console/discord/bindings/${GUILDS[i]}`, { method: "PATCH", headers: h, body: JSON.stringify({ definition: definition.json.id, allowedChannelIds: [CHANNELS[i]], access: { public: true } }) });
    assert.equal(response.status, 200, await response.clone().text()); bindings.push(await response.json());
  }
  mention(0, "400000000000000002", "first Alpha"); mention(1, "400000000000000003", "first Beta");
  await until(() => sent.some(message => message.channel === CHANNELS[0] && message.content === "Alpha answer") && sent.some(message => message.channel === CHANNELS[1] && message.content === "Beta answer"), "two isolated tenant replies");
  const agents = (await r.db.query("select ca.agent,ca.tenant,ca.channel from channel_agents ca order by ca.tenant")).rows;
  assert.equal(agents.length, 2); assert.notEqual(agents[0].agent, agents[1].agent);
  assert.equal((await r.call(`/v1/channels/${bindings[0].channelId}`, { method: "PATCH", body: { access: { public: true } } })).status, 403, "generic channel mutations cannot bypass setup");
  const ownAgent = agents.find(agent => agent.tenant === "alice")!.agent;
  // A turn the account starts through the API still posts only where the server allows, and not while it is paused.
  const before = sent.length;
  const prompted = await r.call(`/v1/agents/${ownAgent}/prompt`, { body: { text: "from the API" } });
  assert.equal(prompted.status, 202);
  await until(() => sent.slice(before).some(message => message.channel === CHANNELS[0] && message.content === "Alpha answer"), "an API turn's reply in its own conversation");
  assert.ok(sent.slice(before).every(message => message.channel === CHANNELS[0]));
  assert.equal((await fetch(`${r.base}/console/discord/bindings/${GUILDS[0]}`, { method: "PATCH", headers: headers[0], body: JSON.stringify({ state: "paused" }) })).status, 200);
  const paused = sent.length;
  const quiet = await r.call(`/v1/agents/${ownAgent}/prompt`, { body: { text: "while paused" } });
  await until(async () => (await r.call(`/v1/agents/${ownAgent}/requests/${quiet.json.id}`)).json.state === "completed", "the paused server's API turn to finish");
  // Its reply is queued once the turn has settled, then dropped at delivery.
  await until(() => r.logs.some(line => line.includes('"type":"channel_item_fenced"') && line.includes(bindings[0].channelId)), "its reply to be dropped");
  assert.equal(sent.length, paused, "a paused server gets no API turn's reply");
  assert.equal((await fetch(`${r.base}/console/discord/bindings/${GUILDS[0]}`, { method: "PATCH", headers: headers[0], body: JSON.stringify({ state: "active" }) })).status, 200);
  // API and scheduled turns count against the server's daily turns; past them they do not post.
  const today = `d${new Date().toISOString().slice(0, 10)}/turns`;
  await r.db.query("insert into channel_counts (channel, window_key, count) values ($1, $2, 1000000) on conflict (channel, window_key) do update set count = 1000000", [bindings[0].channelId, today]);
  const over = sent.length;
  const limited = await r.call(`/v1/agents/${ownAgent}/prompt`, { body: { text: "over the daily limit" } });
  await until(() => r.logs.some(line => line.includes('"type":"channel_turn_over_limit"') && line.includes(limited.json.id)), "an API turn over the server's daily turns");
  assert.equal(sent.length, over);
  await r.db.query("delete from channel_counts where channel = $1 and window_key = $2", [bindings[0].channelId, today]);
  // A definition a server uses cannot take a builtin that starts runs on its own.
  const scheduled = await r.call(`/v1/definitions/${bindings[0].channel.definition}`, { method: "PATCH", body: { builtins: ["schedule"] } });
  assert.equal(scheduled.status, 400); assert.match(scheduled.json.error, /cannot use the schedule builtin/);

  const revised = await r.call("/v1/definitions", { body: { name: "Revised", systemPrompt: "Revised-only", builtins: [] } });
  const changed = await fetch(`${r.base}/console/discord/bindings/${GUILDS[0]}`, { method: "PATCH", headers: headers[0], body: JSON.stringify({ definition: revised.json.id }) });
  assert.equal(changed.status, 200, await changed.clone().text());
  const result = await changed.json() as any; assert.equal(result.applied.length, 1); assert.notEqual(result.applied[0].status, "failed");
  await until(async () => (await r.call(`/v1/agents/${ownAgent}`)).json.definition?.id === revised.json.id, "existing agent takes new definition");
  mention(0, "400000000000000004", "new Alpha configuration");
  await until(() => sent.some(message => message.channel === CHANNELS[0] && message.content === "Revised answer"), "existing conversation uses revised prompt");
  assert.equal((await r.db.query("select count(*)::int n from channel_agents")).rows[0].n, 2, "reconfiguration preserves conversations");
  const switchedBack = await fetch(`${r.base}/console/discord/bindings/${GUILDS[0]}`, { method: "PATCH", headers: headers[0], body: JSON.stringify({ definition: bindings[0].channel.definition }) });
  assert.equal(switchedBack.status, 200);
  await until(async () => (await r.call(`/v1/agents/${ownAgent}`)).json.definition?.id === bindings[0].channel.definition, "definition can switch back without idempotency collision");
  // A first agent can finish provisioning after the server's apply scan, missing that scan.
  // Reproduce the resulting persisted state and verify the next message repairs the old reference.
  await r.db.query("update channels set channel=(channel::jsonb || jsonb_build_object('definition',$2::text))::json where id=$1", [bindings[0].channelId, revised.json.id]);
  const priorReplies = sent.length;
  mention(0, "400000000000000005", "agent finished after the apply scan");
  await until(() => sent.slice(priorReplies).some(message => message.channel === CHANNELS[0] && message.content === "Revised answer"), "late agent takes the configured server definition");
  assert.equal((await r.call(`/v1/agents/${ownAgent}`)).json.definition.id, revised.json.id);
});
