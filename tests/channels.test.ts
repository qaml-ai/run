import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels, chunks } from "../src/channels.ts";
import { LostClaim, Ownership } from "../src/ownership.ts";
import { telegram } from "../src/channels-telegram.ts";
import pg from "pg";
import { testDatabase } from "./database.ts";
import { memoryFiles, requestBody } from "./channel-files.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const operator = "channels-operator-token-at-least-24-chars";
const BOT_TOKEN = "123456789:AAFixtureBotTokenSecretPart_abcdefXYZ";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 15_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function listen(t: T, handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A local stand-in for the Telegram Bot API; the real one is never called. */
async function fakeTelegram(t: T) {
  const calls: { method: string; body: any }[] = [];
  /** Files bots may download, by file_id; getFile answers for others too, and their download is a 404. */
  const files = new Map<string, Buffer>();
  // `holdSends` keeps each sendMessage waiting until the test answers it with a status; `failFiles` fails that many file sends.
  const state = { failSends: 0, failFiles: 0, holdSends: false, held: [] as { body: any; release(status: number): void }[] };
  const url = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const file = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(req.url!);
    if (file) {
      const data = file[1] === BOT_TOKEN && files.get(file[2]);
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(data);
      return;
    }
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url!);
    const answer = (status: number, value: object) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!match || match[1] !== BOT_TOKEN) return answer(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = match[2];
    const body = await requestBody(req, Buffer.concat(chunks));
    if ((method === "sendPhoto" || method === "sendDocument") && state.failFiles > 0) {
      state.failFiles--;
      calls.push({ method: `${method}:failed`, body });
      return answer(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    }
    if (method === "sendMessage" && state.holdSends) {
      const status = await new Promise<number>(release => state.held.push({ body, release }));
      if (status !== 200) {
        calls.push({ method: "sendMessage:failed", body });
        return answer(status, { ok: false, error_code: status, description: "Bad Request" });
      }
    }
    if (method === "sendMessage" && state.failSends > 0) {
      state.failSends--;
      calls.push({ method: "sendMessage:failed", body });
      return answer(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    }
    if (method === "sendPhoto" && body.photo.name.startsWith("wide")) {
      calls.push({ method: "sendPhoto:rejected", body });
      return answer(400, { ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" });
    }
    calls.push({ method, body });
    if (method === "getMe") return answer(200, { ok: true, result: { id: 123456789, is_bot: true, username: "fixture_bot" } });
    if (method === "getFile") return answer(200, { ok: true, result: { file_id: body.file_id, file_size: files.get(body.file_id)?.length, file_path: `files/${body.file_id}` } });
    return answer(200, { ok: true, result: true });
  });
  return {
    url, calls, files, state,
    sent: (chat?: string | number) => calls.filter(call => call.method === "sendMessage" && (chat === undefined || String(call.body.chat_id) === String(chat))).map(call => call.body.text as string),
    count: (method: string) => calls.filter(call => call.method === method).length,
    /** Files sent to a chat, in order: the method, name, caption and bytes. */
    sentFiles: (chat: string | number) => calls.filter(call => (call.method === "sendPhoto" || call.method === "sendDocument") && call.body.chat_id === String(chat))
      .map(call => { const file = call.body.photo ?? call.body.document; return { method: call.method, name: file.name, caption: call.body.caption, data: file.data.toString() }; }),
  };
}

/** An OpenAI-compatible model that answers from the fixture's `respond`. */
async function fakeModel(t: T, respond: (body: any, index: number) => object) {
  const bodies: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const delta = respond(body, bodies.length - 1) as any;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, delta.tool_calls ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, bodies };
}
const lastUser = (body: any) => {
  const content = body.messages.filter((message: any) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("\n");
};

async function runtime(t: T, respond: (body: any, index: number) => object, env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-channels-"));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(operator), apiKeys: { openrouter: "fixture-model-key" } } } }));
  const model = await fakeModel(t, respond);
  const tg = await fakeTelegram(t);
  const { db, url: databaseUrl } = await testDatabase();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: databaseUrl, PORT: "0", HOST: "127.0.0.1",
      ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}),
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "channels-test-session-secret-32-characters",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_PUBLIC_URL: "https://agents.example.test",
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url,
      AGENT_TELEGRAM_API_URL: tg.url, AGENT_SCHEDULER_INTERVAL_MS: "200", AGENT_CHANNEL_RETRY_MS: "100", ...env,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const ready = Promise.withResolvers<number>();
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]).address.port); });
  child.on("exit", code => ready.reject(new Error(`Server exited: ${code}`)));
  const base = `http://127.0.0.1:${await ready.promise}`;
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null } = {}) => {
    const token = init.token === undefined ? operator : init.token;
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text };
  };
  const createChannel = async (fields: object = {}) => {
    const created = await call("/v1/channels", { body: { type: "telegram", credentials: { botToken: BOT_TOKEN }, ...fields } });
    assert.equal(created.status, 201, created.text);
    const secret = tg.calls.filter(entry => entry.method === "setWebhook").at(-1)!.body.secret_token as string;
    return { channel: created.json, secret };
  };
  let update = 1000;
  /** Deliver a Telegram update to the channel's webhook, as Telegram would. */
  const deliver = (channel: { id: string }, secret: string | undefined, message: Record<string, unknown>, updateId = ++update) => fetch(`${base}/channels/telegram/${channel.id}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(secret !== undefined ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, date: 0, ...message } }),
  }).then(response => response.status);
  return { root, db, base, call, tg, model, createChannel, deliver };
}
const ada = { id: 42, is_bot: false, first_name: "Ada", username: "ada" };
const bob = { id: 7, is_bot: false, first_name: "Bob", username: "bob" };
const from = (user: typeof ada, text: string, chat = user.id) => ({ from: user, chat: { id: chat, type: "private" }, text });

test("channel credentials are encrypted, never returned, and the webhook is registered and removed", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  assert.equal((await r.call("/v1/channels", { body: { type: "telegram", credentials: { botToken: "999:not-the-fixture-token-at-all-x" } } })).status, 422);
  assert.equal((await r.call("/v1/channels", { body: { type: "telegram", credentials: {} } })).status, 400);
  assert.equal((await r.call("/v1/channels", { body: { type: "sms", credentials: { botToken: BOT_TOKEN } } })).status, 400);
  const { channel, secret } = await r.createChannel({ name: "Support", access: { allow: ["@ada"] } });
  assert.equal(channel.webhookUrl, `https://agents.example.test/channels/telegram/${channel.id}`);
  assert.deepEqual(r.tg.calls.find(entry => entry.method === "setWebhook")!.body, { url: channel.webhookUrl, secret_token: secret, allowed_updates: ["message"] });
  assert.equal(channel.credentials.botToken, "123456789:…fXYZ");
  assert.deepEqual(channel.account, { id: "123456789", username: "fixture_bot" });

  const updated = await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { name: "Help desk", limits: { turnsPerDay: 5 } } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.limits.turnsPerDay, 5);
  for (const response of [updated, await r.call("/v1/channels"), await r.call(`/v1/channels/${channel.id}`)]) {
    assert.equal(response.text.includes(BOT_TOKEN.split(":")[1]), false);
    assert.equal(response.text.includes(secret), false);
  }
  const stored = JSON.stringify((await r.db.query("select * from channels where id = $1", [channel.id])).rows[0]);
  assert.equal(stored.includes(BOT_TOKEN.split(":")[1]), false);
  assert.equal(stored.includes(secret), false);
  assert.equal((await r.call("/v1/channels")).json.length, 1);
  assert.equal((await r.call("/v1/channels", { token: null })).status, 401);

  // The webhook answers only requests carrying the secret Telegram was given.
  assert.equal(await r.deliver(channel, undefined, from(ada, "hi")), 401);
  assert.equal(await r.deliver(channel, "x".repeat(secret.length), from(ada, "hi")), 401);
  assert.equal(await r.deliver(channel, secret.slice(1), from(ada, "hi")), 401);
  assert.equal(await r.deliver({ id: "ch_00000000000000000000" }, secret, from(ada, "hi")), 404);
  assert.equal(await r.deliver(channel, secret, from(ada, "hi")), 200);

  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "DELETE" })).status, 200);
  assert.equal(r.tg.count("deleteWebhook"), 1);
  assert.equal((await r.call(`/v1/channels/${channel.id}`)).status, 404);
  assert.equal(await r.deliver(channel, secret, from(ada, "hi")), 404);
});

test("each conversation gets its own agent; replies are chunked; a retried update is handled once", async t => {
  const long = Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ");
  const r = await runtime(t, body => ({ role: "assistant", content: lastUser(body).endsWith("long please") ? long : `echo: ${lastUser(body).split("\n").at(-1)}` }));
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ada", "7"] } });

  assert.equal(await r.deliver(channel, secret, from(ada, "long please"), 5001), 200);
  const expected = chunks(long, 4096);
  assert.equal(expected.length, 4);
  const parts = await until(() => r.tg.sent(ada.id).length >= expected.length && r.tg.sent(ada.id), "the chunked reply");
  assert.ok(parts.every(part => part.length <= 4096));
  assert.ok(parts.join(" ") === long, "the parts make up the whole reply");
  assert.ok(r.tg.count("sendChatAction") >= 1, "typing is shown while the agent works");
  // The runtime tells the agent who is talking, in a block apart from what they wrote.
  assert.equal(lastUser(r.model.bodies[0]), `<<<RUNTIME_CONTEXT>>>\n{"from":{"id":"telegram:42","name":"Ada","username":"ada"}}\n<<<END_RUNTIME_CONTEXT>>>\nlong please`);

  // Telegram retries an update it thinks was lost: it is recorded once and answered once.
  assert.equal(await r.deliver(channel, secret, from(ada, "long please"), 5001), 200);
  await Promise.all([r.deliver(channel, secret, from(ada, "second"), 5002), r.deliver(channel, secret, from(ada, "second"), 5002)]);
  await until(() => r.tg.sent(ada.id).includes("echo: second"), "the second reply");
  await sleep(500);
  assert.equal(r.model.bodies.length, 2);
  assert.equal(r.tg.sent(ada.id).length, parts.length + 1);

  const agents = async () => (await r.call("/v1/agents")).json as any[];
  assert.equal((await agents()).length, 1, "the same conversation reuses its agent");
  assert.equal((await agents())[0].name, "Telegram: @ada");
  await r.deliver(channel, secret, from(bob, "hello from bob"));
  await until(() => r.tg.sent(bob.id).includes("echo: hello from bob"), "bob's reply");
  assert.equal((await agents()).length, 2, "another conversation gets another agent");
  // Bob's agent saw only Bob's conversation.
  assert.equal(r.model.bodies[2].messages.filter((message: any) => message.role === "user").length, 1);
  await until(async () => (await r.db.query("select count(*) as count from channel_items")).rows[0].count === 0, "no work left over");
});

test("senders outside the allowlist are ignored unless the channel is public; /start is greeted", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` }));
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ADA"] }, greeting: "Welcome aboard." });
  await r.deliver(channel, secret, from(bob, "let me in"));
  await r.deliver(channel, secret, from(ada, "/start"));
  await until(() => r.tg.sent(ada.id).includes("Welcome aboard."), "the greeting");
  await r.deliver(channel, secret, from(ada, "hello"));
  await until(() => r.tg.sent(ada.id).includes("echo: hello"), "ada's reply");
  assert.deepEqual(r.tg.sent(bob.id), []);
  assert.equal(r.model.bodies.length, 1, "neither the stranger nor /start reached the model");

  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { access: { public: true } } })).json.access.public, true);
  await r.deliver(channel, secret, from(bob, "let me in"));
  await until(() => r.tg.sent(bob.id).includes("echo: let me in"), "bob's reply once public");
});

test("each sender is rate limited, and told once", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` }));
  const { channel, secret } = await r.createChannel({ access: { public: true }, limits: { perSenderPerMinute: 2 } });
  for (const text of ["one", "two", "three", "four"]) await r.deliver(channel, secret, from(ada, text));
  await until(() => r.tg.sent(ada.id).filter(text => text.startsWith("echo:")).length === 2, "two replies");
  await sleep(500);
  const sent = r.tg.sent(ada.id);
  assert.equal(sent.filter(text => text.includes("too quickly")).length, 1);
  assert.equal(sent.length, 3);
  assert.equal(r.model.bodies.length, 2);
  // Other senders have their own budget.
  await r.deliver(channel, secret, from(bob, "hi"));
  await until(() => r.tg.sent(bob.id).includes("echo: hi"), "bob's reply");
});

test("a photo reaches the model as an image", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Nice photo." }));
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  // A JPEG's start and frame header (5×5), then noise: inspection reads only the header.
  const small = Buffer.from("small-thumbnail"), large = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x05, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), randomBytes(2048)]);
  r.tg.files.set("thumb", small);
  r.tg.files.set("full", large);
  await r.deliver(channel, secret, {
    from: ada, chat: { id: ada.id, type: "private" }, caption: "What is this?",
    photo: [{ file_id: "thumb", file_unique_id: "t", width: 90, height: 90, file_size: small.length }, { file_id: "full", file_unique_id: "f", width: 1280, height: 1280, file_size: large.length }],
  });
  await until(() => r.tg.sent(ada.id).includes("Nice photo."), "the reply");
  assert.deepEqual(r.tg.calls.filter(entry => entry.method === "getFile").map(entry => entry.body.file_id), ["full"]);
  const content = r.model.bodies[0].messages.find((message: any) => message.role === "user").content;
  assert.ok(Array.isArray(content));
  assert.ok(content.some((part: any) => part.text === "What is this?"));
  // Saved in the agent's workspace, then shown as it was sent.
  assert.ok(content.some((part: any) => /^\[File \/workspace\/uploads\/[^/]+\/photo\.jpg \(image\/jpeg, 3 KB\)\]$/.test(part.text ?? "")));
  assert.equal(content.find((part: any) => part.type === "image_url").image_url.url, `data:image/jpeg;base64,${large.toString("base64")}`);
});

test("every kind of Telegram attachment is saved to the agent's workspace and attached by path; ones too large or failing are noted", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Got it." }));
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  const cases: [Record<string, unknown>, string][] = [
    [{ document: { file_id: "doc", file_name: "report.csv", mime_type: "text/csv", file_size: 10 } }, "report.csv (text/csv"],
    [{ audio: { file_id: "aud", file_name: "song.mp3", mime_type: "audio/mpeg" } }, "song.mp3 (audio/mpeg"],
    [{ voice: { file_id: "voi", mime_type: "audio/ogg" } }, "voice.ogg (audio/ogg"],
    [{ video: { file_id: "vid", mime_type: "video/mp4" } }, "video.mp4 (video/mp4"],
    // An animation comes with a copy of itself as a document: it is one file.
    [{ animation: { file_id: "ani", file_name: "cat.mp4", mime_type: "video/mp4" }, document: { file_id: "ani", file_name: "cat.mp4", mime_type: "video/mp4" } }, "cat.mp4 (video/mp4"],
  ];
  for (const [index, [attachment, shown]] of cases.entries()) {
    const id = Object.values(attachment)[0] as { file_id: string };
    r.tg.files.set(id.file_id, Buffer.from(`${id.file_id} bytes`));
    await r.deliver(channel, secret, { from: ada, chat: { id: ada.id, type: "private" }, ...attachment });
    await until(() => r.tg.sent(ada.id).length === index + 1, `the reply to ${shown}`);
    const user = lastUser(r.model.bodies[index]);
    assert.equal(user.match(/\[File /g)?.length, 1, "one file per message");
    assert.ok(new RegExp(`\\[File /workspace/uploads/in_[a-f0-9]{40}/${shown.replace(/[.()]/g, "\\$&")}, 1 KB\\)\\]`).test(user), user);
    assert.ok(user.includes("(sent a file)"));
  }
  // The bytes are in the agent's workspace volume.
  const [agent] = (await r.call("/v1/agents")).json;
  const [mount] = (await r.call(`/v1/agents/${agent.id}/mounts`)).json;
  const path = /\/workspace(\/uploads\/[^ ]+\/report\.csv)/.exec(lastUser(r.model.bodies[0]))![1];
  assert.equal((await r.call(`/v1/volumes/${mount.volumeId}/files${path}`)).text, "doc bytes");

  // Over Telegram's 20 MB download limit, and a file Telegram cannot serve: noted, not attached.
  await r.deliver(channel, secret, { from: ada, chat: { id: ada.id, type: "private" }, caption: "the big one", document: { file_id: "big", file_name: "big.zip", file_size: 21_000_000 } });
  await until(() => r.tg.sent(ada.id).length === cases.length + 1, "the reply to the big file");
  assert.ok(lastUser(r.model.bodies.at(-1)).endsWith("the big one\n(file big.zip too large, not attached)"));
  await r.deliver(channel, secret, { from: ada, chat: { id: ada.id, type: "private" }, document: { file_id: "lost", file_name: "lost.txt" } });
  await until(() => r.tg.sent(ada.id).length === cases.length + 2, "the reply to the lost file");
  assert.ok(lastUser(r.model.bodies.at(-1)).endsWith("\n(file lost.txt could not be downloaded, not attached)"));
  assert.ok(!r.model.bodies.at(-1).messages.some((message: any) => JSON.stringify(message).includes("[File /workspace/uploads/in_") && JSON.stringify(message).includes("lost.txt")));
});

test("presented files follow the reply: images as photos, others as documents, too large as links; a retry resends nothing already sent", async t => {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const workspace = memoryFiles();
  const channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test", retryBaseMs: 50, files: workspace.files,
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
  const channel = await channels.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('client_x', $1, 'default', '42')", [channel.id]);
  const presented = [
    workspace.present("/workspace/chart.png", Buffer.from("png bytes"), "image/png", { caption: "The chart" }),
    workspace.present("/workspace/data.csv", Buffer.from("a,b\n1,2\n"), "text/csv"),
    workspace.present("/workspace/wide.png", Buffer.from("wide bytes"), "image/png"),
    workspace.present("/workspace/movie.mp4", Buffer.from("mp4"), "video/mp4", { size: 60_000_000 }),
  ];
  // The first file send fails; the retry resumes with it, not with the text before it.
  tg.state.failFiles = 1;
  channels.hooks.runEnded!({ id: "client_x", tenant: "default" }, { id: "schedule-1", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "Here are your files.", presented } } });
  await until(() => tg.count("sendPhoto:failed") === 1, "the failed send");
  await until(async () => { await channels.scan(); return tg.sent("42").length === 2; }, "the rest, retried");
  assert.deepEqual(tg.sent("42"), ["Here are your files.", "movie.mp4 (57.2 MB, too large to send here; the link works for 24 hours): https://agents.example.test/v1/links/fixture/workspace/movie.mp4"]);
  assert.deepEqual(tg.sentFiles("42"), [
    { method: "sendPhoto", name: "chart.png", caption: "The chart", data: "png bytes" },
    { method: "sendDocument", name: "data.csv", caption: undefined, data: "a,b\n1,2\n" },
    // Telegram would not take it as a photo.
    { method: "sendDocument", name: "wide.png", caption: undefined, data: "wide bytes" },
  ]);
  const order = tg.calls.map(call => call.method).filter(method => method.startsWith("send"));
  assert.deepEqual(order, ["sendMessage", "sendPhoto:failed", "sendPhoto", "sendDocument", "sendPhoto:rejected", "sendDocument", "sendMessage"]);
  assert.equal((await db.query("select count(*) as count from channel_items")).rows[0].count, 0);
});

test("files the agent presents reach the chat after its reply", async t => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const call = (name: string, args: object, index: number) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const r = await runtime(t, (_body, index) => [
    call("write", { path: "/workspace/out/chart.png", content: png.toString("base64"), encoding: "base64", contentType: "image/png" }, index),
    call("write", { path: "/workspace/out/data.csv", content: "a,b\n1,2\n" }, index),
    call("present_file", { path: "/workspace/out/chart.png", caption: "Q3 chart" }, index),
    call("present_file", { path: "/workspace/out/data.csv" }, index),
  ][index] ?? { role: "assistant", content: "Here you go." });
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  await r.deliver(channel, secret, from(ada, "chart please"));
  await until(() => r.tg.sentFiles(ada.id).length === 2, "the files");
  assert.deepEqual(r.tg.sent(ada.id), ["Here you go."]);
  assert.deepEqual(r.tg.sentFiles(ada.id), [
    { method: "sendPhoto", name: "chart.png", caption: "Q3 chart", data: png.toString() },
    { method: "sendDocument", name: "data.csv", caption: undefined, data: "a,b\n1,2\n" },
  ]);
  assert.deepEqual(r.tg.calls.map(entry => entry.method).filter(method => /^send(Message|Photo|Document)/.test(method)), ["sendMessage", "sendPhoto", "sendDocument"]);
});

test("send_message sends files from the agent's mounts, and refuses paths outside them", async t => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x05, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), randomBytes(64)]);
  const r = await runtime(t, (body, index) => {
    const photo = /\[File (\/workspace\/uploads\/[^ ]+\/photo\.jpg) /.exec(lastUser(body))?.[1];
    const send = (args: object) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: "send_message", arguments: JSON.stringify(args) } }] });
    if (index === 0) return send({ text: "Trying", files: ["/workspace/nope.txt"] });
    if (index === 1) return send({ text: "Here it is", files: [photo] });
    return { role: "assistant", content: "Done." };
  });
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  r.tg.files.set("pic", jpeg);
  await r.deliver(channel, secret, { from: ada, chat: { id: ada.id, type: "private" }, caption: "send it back", photo: [{ file_id: "pic", file_unique_id: "p", width: 5, height: 5, file_size: jpeg.length }] });
  await until(() => r.tg.sent(ada.id).includes("Done."), "the final reply");
  assert.match(r.model.bodies[1].messages.find((message: any) => message.role === "tool").content, /does not exist/);
  assert.deepEqual(r.tg.sent(ada.id), ["Here it is", "Done."]);
  assert.deepEqual(r.tg.sentFiles(ada.id), [{ method: "sendPhoto", name: "photo.jpg", caption: undefined, data: jpeg.toString() }]);
  const order = r.tg.calls.map(call => call.method).filter(method => method === "sendMessage" || method === "sendPhoto");
  assert.deepEqual(order, ["sendMessage", "sendPhoto", "sendMessage"]);
});

test("send_message reaches the chat mid-turn, and tools see who is asking", async t => {
  // A remote MCP server whose tool records the runtime's _meta: the channel and sender of the turn.
  const seen: unknown[] = [];
  const mcpUrl = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const server = new McpServer({ name: "orders", version: "1.0.0" });
    server.registerTool("lookup", { description: "Look up an order" }, async extra => {
      seen.push(extra._meta?.["agent-runtime/origin"]);
      return { content: [{ type: "text", text: "shipped" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  const r = await runtime(t, (body, index) => {
    if (index === 0) return { role: "assistant", tool_calls: [{ index: 0, id: "call_update", type: "function", function: { name: "send_message", arguments: JSON.stringify({ text: "Working on it…" }) } }] };
    if (index === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "orders__lookup", arguments: "{}" } }] };
    return { role: "assistant", content: "All done." };
  }, { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" });
  const definition = (await r.call("/v1/definitions", { body: { name: "Orders", mcpServers: [{ name: "orders", url: `${mcpUrl}/mcp`, exposure: "direct" }] } })).json;
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ada"] }, definition: definition.id });
  await r.deliver(channel, secret, from(ada, "check my order"));
  await until(() => r.tg.sent(ada.id).includes("All done."), "the final reply");
  assert.deepEqual(r.tg.sent(ada.id), ["Working on it…", "All done."]);
  assert.equal(r.model.bodies[0].tools.some((tool: any) => tool.function.name === "send_message"), true);
  const tool = r.model.bodies[1].messages.find((message: any) => message.role === "tool");
  assert.match(tool.content, /sent/);
  assert.deepEqual(seen, [{ channel: { id: channel.id, type: "telegram" }, conversationId: "42", sender: { id: "42", username: "ada", name: "Ada" } }]);
});

test("a channel's agents are made from its definition; one created without gets an empty one of its own", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `system: ${body.messages[0].content.includes("Pirate") ? "pirate" : "plain"}` }));
  const pirate = (await r.call("/v1/definitions", { body: { name: "Pirate", systemPrompt: "Pirate talk only." } })).json;
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ada"] }, definition: pirate.id });
  assert.equal(channel.definition, pirate.id);
  assert.equal("template" in channel, false);
  await r.deliver(channel, secret, from(ada, "ahoy"));
  await until(() => r.tg.sent(ada.id).includes("system: pirate"), "the reply");
  const [agent] = (await r.call("/v1/agents")).json;
  const detail = (await r.call(`/v1/agents/${agent.id}`)).json;
  assert.deepEqual(detail.definition, { id: pirate.id, revision: 1 });
  assert.equal((await r.call(`/v1/definitions/${pirate.id}`, { method: "DELETE" })).status, 409, "a channel uses it");

  // Created without a definition, a channel gets an empty one of its own, which it keeps and which is deleted with it.
  const plain = await r.createChannel({ name: "Plain", access: { allow: ["@bob"] } });
  const own = (await r.call(`/v1/definitions/${plain.channel.definition}`)).json;
  assert.deepEqual([own.name, own.revision], ["Plain", 1]);
  assert.equal((await r.call(`/v1/channels/${plain.channel.id}`, { method: "PATCH", body: { name: "Renamed" } })).json.definition, own.id);
  assert.equal((await r.call(`/v1/channels/${plain.channel.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/definitions/${own.id}`)).status, 404);
  assert.equal((await r.call(`/v1/definitions/${pirate.id}`)).status, 200);
});

test("an outbound message that fails is retried, and delivered exactly once across two scanners", async t => {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const node = (name: string) => new Channels({
    db, definitions: new Definitions({ db }), accounts, node: name, publicUrl: "https://agents.example.test", retryBaseMs: 50,
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
  const [a, b] = [node("a"), node("b")];
  const channel = await a.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('client_x', $1, 'default', '42')", [channel.id]);

  // A scheduled turn on the conversation's agent ends while Telegram is failing.
  tg.state.failSends = 1;
  const reply = `${"x".repeat(4090)}\n${"y".repeat(10)}`;
  a.hooks.runEnded!({ id: "client_x", tenant: "default" }, { id: "schedule-1", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply } } });
  await until(() => tg.calls.some(entry => entry.method === "sendMessage:failed"), "the failed send");
  const released = await until(async () => (await db.query("select item from channel_items where claimed_by is null")).rows[0], "the released item");
  assert.equal(released.item.attempts, 1);

  // Both nodes scan at once, repeatedly: one claims the item, and it is sent once.
  await sleep(60);
  for (let round = 0; round < 5; round++) { await Promise.all([a.scan(), b.scan()]); await sleep(20); }
  assert.deepEqual(tg.sent("42"), ["x".repeat(4090), "y".repeat(10)]);
  assert.equal((await db.query("select count(*) as count from channel_items")).rows[0].count, 0);
});

test("a node whose claim on a message lapsed, and whose send then fails for good, leaves the message to the node that retook it", async t => {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const node = (name: string) => new Channels({
    db, definitions: new Definitions({ db }), accounts, node: name, publicUrl: "https://agents.example.test", retryBaseMs: 50,
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
  const [a, b] = [node("a"), node("b")];
  const channel = await a.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('client_x', $1, 'default', '42')", [channel.id]);
  const items = async () => Number((await db.query("select count(*) as count from channel_items")).rows[0].count);

  tg.state.holdSends = true;
  a.hooks.runEnded!({ id: "client_x", tenant: "default" }, { id: "schedule-1", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "hello" } } });
  await until(() => tg.state.held.length === 1, "a's send");
  // a's send hangs past its claim, and b retakes the message.
  await db.query("update channel_items set claimed_until = now() - interval '1 second'");
  const scanned = b.scan();
  await until(() => tg.state.held.length === 2, "b's send");
  tg.state.held[0].release(400);
  await until(() => tg.calls.some(call => call.method === "sendMessage:failed"), "a's permanent failure");
  await sleep(100);
  assert.equal(await items(), 1, "a gave up on its copy without deleting b's");
  tg.state.held[1].release(200);
  await scanned;
  assert.equal(await items(), 0);
  assert.deepEqual(tg.sent("42"), ["hello"]);
});

test("a node that lost an agent sends nothing more for it", async t => {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  t.after(() => ownership.close().catch(() => {}));
  const taken = await ownership.acquire("client_x");
  assert.ok("claim" in taken);
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "http://a", publicUrl: "https://agents.example.test", ownership,
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
  const channel = await channels.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('client_x', $1, 'default', '42')", [channel.id]);
  const agent = { id: "client_x", tenant: "default", claim: taken.claim };
  assert.equal(await channels.hooks.server!({ id: "client_elsewhere", tenant: "default" }), undefined, "agents no channel made have no send_message");
  const server = (await channels.hooks.server!(agent))!;
  const send = (text: string) => server.call({ name: "send_message", args: { text }, signal: new AbortController().signal });
  assert.deepEqual((await send("first")).structuredContent, { sent: true });

  // A peer took the agent; this node's turn is still running and tries to talk.
  await db.query("update actor_owners set node = 'http://b', session = gen_random_uuid(), epoch = epoch + 1 where actor = 'client_x'");
  await assert.rejects(send("stale"), LostClaim);
  channels.hooks.runEnded!(agent, { id: "schedule-2", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "stale reply" } } });
  await sleep(200);
  assert.deepEqual(tg.sent("42"), ["first"]);
  assert.equal(Number((await db.query("select count(*) as count from channel_items")).rows[0].count), 0);
});

test("a backlog of outbound messages is sent exactly once when two nodes on separate connections drain it", async t => {
  const tg = await fakeTelegram(t);
  const { db, url } = await testDatabase();
  const secretsKey = randomBytes(32).toString("hex");
  const node = (name: string) => {
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    t.after(() => pool.end());
    return new Channels({ definitions: new Definitions({ db: pool }),
      db: pool, accounts: new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: pool, secretsKey }), node: name, publicUrl: "https://agents.example.test",
      providers: { telegram: telegram({ apiUrl: tg.url }) },
      createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
    });
  };
  const [a, b] = [node("a"), node("b")];
  const channel = await a.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  const now = Date.now();
  for (let index = 0; index < 40; index++) {
    const item = { id: `out_${index}`, channel: channel.id, tenant: "default", conversationId: "42", createdAt: now, state: "sending", text: `message ${index}`, sent: 0, attempts: 0 };
    await db.query("insert into channel_items (id, item, due) values ($1, $2, $3)", [item.id, JSON.stringify(item), now]);
  }
  for (let round = 0; round < 3; round++) await Promise.all([a.scan(), b.scan(), a.scan(), b.scan()]);
  assert.deepEqual(tg.sent("42").sort(), Array.from({ length: 40 }, (_, index) => `message ${index}`).sort());
  assert.equal((await db.query("select count(*) as count from channel_items")).rows[0].count, 0);
});

test("a turn whose end no node saw (a crash) is re-checked and answered once", async t => {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const submitted: string[] = [];
  let finished = false;
  const channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test",
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async (_tenant, _params, key) => ({ id: `client_${sha(key).slice(0, 40)}` }), agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    // The agent's journal answers a repeated request id with the same record.
    submit: async (_agent, _tenant, request) => {
      submitted.push(request.id);
      return { id: request.id, method: "prompt", fingerprint: "", state: finished ? "completed" : "running", ...(finished ? { outcome: { result: { reply: "Recovered." } } } : {}) };
    },
  });
  const channel = await channels.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  const secret = tg.calls.find(entry => entry.method === "setWebhook")!.body.secret_token;
  const post = () => channels.app.request(`/channels/telegram/${channel.id}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, ...from(ada, "are you there?") } }),
  });
  assert.equal((await post()).status, 200);
  await until(() => submitted.length === 1, "the prompt");

  // Still running at the first re-check; finished (unobserved) by the second.
  await channels.scan(Date.now() + 61_000);
  assert.deepEqual(tg.sent(), []);
  finished = true;
  await channels.scan(Date.now() + 122_000);
  await channels.scan(Date.now() + 300_000);
  assert.deepEqual(tg.sent("42"), ["Recovered."]);
  assert.equal(submitted.length, 3);
  assert.equal((await db.query("select count(*) as count from channel_items")).rows[0].count, 0);
  // Telegram retrying the update now finds it handled.
  assert.equal((await post()).status, 200);
  await sleep(50);
  assert.equal(submitted.length, 3);
});

test("replies split at line and word breaks within the limit", () => {
  assert.deepEqual(chunks("short", 10), ["short"]);
  assert.deepEqual(chunks("aaaa bbbb cccc", 10), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(chunks("aaa\nbbbbbb cc", 10), ["aaa\nbbbbbb", "cc"]);
  assert.deepEqual(chunks("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.ok(chunks("😀".repeat(10), 5).every(part => !/[\uD800-\uDBFF]$/.test(part)));
});
