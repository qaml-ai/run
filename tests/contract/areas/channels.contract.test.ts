import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { Accounts } from "../../../src/accounts.ts";
import { Tenants } from "../../../src/tenants.ts";
import { Definitions } from "../../../src/definitions.ts";
import { Channels, type ChannelFiles } from "../../../src/channels.ts";
import { LostClaim, Ownership } from "../../../src/ownership.ts";
import { telegram } from "../../../src/channels-telegram.ts";
import { testDatabase } from "../../database.ts";
import { memoryFiles } from "../../channel-files.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { answerOf, askText, chunks } from "../../../src/core/channels/channels.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { contractTest, listen, OPERATOR, sleep, until } from "../support.ts";
import { ada, bob, BOT_TOKEN, fakeTelegram, from, lastUser, telegramChannels, type FakeTelegram } from "../channel-fakes.ts";

/** Telegram channels on either backend: the fake Bot API stands in for Telegram, the fixture's model for the agent's. */
type R = ContractFixture & { tg: FakeTelegram } & ReturnType<typeof telegramChannels>;
function channelTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions = {}) {
  let tg: FakeTelegram;
  contractTest("channels", source, name, (t, fixture) => body(t, Object.assign(fixture, { tg }, telegramChannels(fixture, tg))), {
    ...options, env: { AGENT_CHANNEL_RETRY_MS: "100", ...options.env },
    prepare: async t => {
      tg = await fakeTelegram(t);
      return { AGENT_TELEGRAM_API_URL: tg.url, ...await options.prepare?.(t) };
    },
  });
}

channelTest("tests/channels.test.ts:183", "channel credentials are encrypted, never returned, and the webhook is registered and removed", async (_t, r) => {
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
    assert.equal(response.text.includes(BOT_TOKEN.split(":")[1]!), false);
    assert.equal(response.text.includes(secret), false);
  }
  const stored = JSON.stringify((await r.channelQuery("select * from channels where id = $1", [channel.id])).rows[0]);
  assert.equal(stored.includes(BOT_TOKEN.split(":")[1]!), false);
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

channelTest("tests/channels.test.ts:250", "each conversation gets its own agent; replies are chunked; a retried update is handled once", async (_t, r) => {
  const long = Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ");
  r.setModel(body => ({ role: "assistant", content: lastUser(body).endsWith("long please") ? long : `echo: ${lastUser(body).split("\n").at(-1)}` }));
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
  await until(async () => Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count) === 0, "no work left over");
});

channelTest("tests/channels.test.ts:284", "senders outside the allowlist are ignored unless the channel is public; /start is greeted", async (_t, r) => {
  r.setModel(body => ({ role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` }));
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

channelTest("tests/channels.test.ts:300", "each sender is rate limited, and told once", async (_t, r) => {
  r.setModel(body => ({ role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` }));
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

channelTest("tests/channels.test.ts:220", "Discord is retired: creating one is refused with where Discord bots went; a stored one stays, shows disabled, answers nothing and can be deleted", async (_t, r) => {
  for (const type of ["discord", "discord-managed"]) {
    const refused = await r.call("/v1/channels", { body: { type, credentials: { botToken: "x".repeat(60) } } });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.code, "CHANNEL_TYPE_RETIRED");
    assert.match(refused.json.error, /camelBots \(https:\/\/bots\.camelai\.com\)/);
  }
  // A channel stored before Discord was retired: no migration touches it.
  const id = "ch_dddddddddddddddddddd";
  const stored = { id, tenant: "alice", type: "discord", name: "Old bot", definition: "def_none", access: { public: true, allow: [] }, limits: { perSenderPerMinute: 10, turnsPerDay: 1000 },
    account: { id: "1" }, masked: { botToken: "…abcd" }, sealed: { v: 1 }, createdAt: 1, updatedAt: 1 };
  await r.channelQuery("insert into channels (id, tenant, channel, created_at) values ($1, 'alice', $2, 1)", [id, JSON.stringify(stored)]);
  // Work it had queued is dropped, not retried.
  const item = { id: "in_retired", channel: id, tenant: "alice", conversationId: "c1", createdAt: 1, state: "received", inbound: { conversationId: "c1", messageId: "m1", sender: { id: "u1" }, text: "hi", files: [] } };
  await r.channelQuery("insert into channel_items (id, item, due) values ('in_retired', $1, 0)", [JSON.stringify(item)]);
  const listed = await r.call("/v1/channels");
  assert.deepEqual(listed.json.map((channel: any) => [channel.id, channel.type, channel.disabled]), [[id, "discord", true]]);
  assert.equal((await r.call(`/v1/channels/${id}`)).json.disabled, true);
  const patched = await r.call(`/v1/channels/${id}`, { method: "PATCH", body: { name: "Renamed" } });
  assert.equal(patched.status, 400);
  assert.equal(patched.json.code, "CHANNEL_TYPE_RETIRED");
  // Workers scan when work comes due, not on a timer: a retry on a live channel gives them one.
  const live = await r.createChannel({ access: { public: true } });
  r.tg.state.failSends = 1;
  await r.deliver(live.channel, live.secret, from(ada, "hi"));
  for (let i = 0; i < 100 && (await r.channelQuery("select 1 from channel_items where id = 'in_retired'")).rowCount; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await r.channelQuery("select 1 from channel_items where id = 'in_retired'")).rowCount, 0);
  assert.equal((await r.channelQuery("select 1 from channel_conversations where channel = $1", [id])).rowCount, 0, "no agent was made for it");
  assert.equal((await r.channelQuery("select channel->>'name' as name from channels where id = $1", [id])).rows[0].name, "Old bot");
  assert.equal((await r.call(`/v1/channels/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/channels/${id}`)).status, 404);
});

channelTest("tests/channels.test.ts:315", "a photo reaches the model as an image", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Nice photo." }));
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  // A real 5×5 JPEG, padded to 3 KB so it is distinct from the smaller thumbnail.
  const small = Buffer.from("small-thumbnail"), large = Buffer.concat([
    await sharp({ create: { width: 5, height: 5, channels: 3, background: "red" } }).jpeg().toBuffer(), Buffer.alloc(2048),
  ]);
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

channelTest("tests/channels.test.ts:338", "every kind of Telegram attachment is saved to the agent's workspace and attached by path; ones too large or failing are noted", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Got it." }));
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
    // A text file comes with its first lines.
    // Audio is transcribed by default: these bytes are not audio, so it is attached without a transcript, saying why.
    const why = shown.includes("audio/") ? ": not transcribed \\(.*\\)" : "";
    assert.ok(new RegExp(`\\[File /workspace/uploads/in_[a-f0-9]{40}/${shown.replace(/[.()]/g, "\\$&")}, 1 KB\\)${shown.includes("text/") ? `, beginning:\\n${id.file_id} bytes` : ""}${why}\\]`).test(user), user);
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

const toolCall = (name: string, args: object, index: number) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

// The original ran Channels over in-memory files; here the agent writes and presents real files in its volume.
channelTest("tests/channels.test.ts:378", "presented files follow the reply: images as photos, others as documents, too large as links; a retry resends nothing already sent", async (_t, r) => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const { channel, secret } = await r.createChannel({ access: { allow: ["42"] } });
  r.setModel(() => ({ role: "assistant", content: "Ready." }));
  await r.deliver(channel, secret, from(ada, "warm up"));
  await until(() => r.tg.sent(ada.id).includes("Ready."), "the agent's first reply");
  // A file over Telegram's 50 MB upload limit, put in the agent's volume directly.
  const [agent] = (await r.call("/v1/agents")).json;
  const [mount] = (await r.call(`/v1/agents/${agent.id}/mounts`)).json;
  const movie = await fetch(`${r.base}/v1/volumes/${mount.volumeId}/files/out/movie.mp4`, { method: "PUT", headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "video/mp4" }, body: Buffer.alloc(60_000_000) });
  assert.equal(movie.status, 201, await movie.text());

  r.setModel((_body, index) => [
    toolCall("write", { path: "/workspace/out/chart.png", content: png.toString("base64"), encoding: "base64", contentType: "image/png" }, index),
    toolCall("write", { path: "/workspace/out/data.csv", content: "a,b\n1,2\n", contentType: "text/csv" }, index),
    toolCall("write", { path: "/workspace/out/wide.png", content: png.toString("base64"), encoding: "base64", contentType: "image/png" }, index),
    toolCall("present_file", { path: "/workspace/out/chart.png", caption: "The chart" }, index),
    toolCall("present_file", { path: "/workspace/out/data.csv" }, index),
    toolCall("present_file", { path: "/workspace/out/wide.png" }, index),
    toolCall("present_file", { path: "/workspace/out/movie.mp4" }, index),
  ][index] ?? { role: "assistant", content: "Here are your files." });
  const before = r.tg.calls.length;
  // The first file send fails; the retry resumes with it, not with the text before it.
  r.tg.state.failFiles = 1;
  await r.deliver(channel, secret, from(ada, "files please"));
  await until(() => r.tg.sent(ada.id).length === 3, "the reply and the link, retried");
  const sent = r.tg.sent(ada.id).slice(1);
  assert.equal(sent[0], "Here are your files.");
  assert.match(sent[1]!, /^movie\.mp4 \(57\.2 MB, too large to send here; the link works for 24 hours\): https:\/\/agents\.example\.test\/\S+$/);
  assert.deepEqual(r.tg.sentFiles(ada.id), [
    { method: "sendPhoto", name: "chart.png", caption: "The chart", data: png.toString() },
    { method: "sendDocument", name: "data.csv", caption: undefined, data: "a,b\n1,2\n" },
    // Telegram would not take it as a photo.
    { method: "sendDocument", name: "wide.png", caption: undefined, data: png.toString() },
  ]);
  const order = r.tg.calls.slice(before).map(call => call.method).filter(method => method.startsWith("send") && method !== "sendChatAction");
  assert.deepEqual(order, ["sendMessage", "sendPhoto:failed", "sendPhoto", "sendDocument", "sendPhoto:rejected", "sendDocument", "sendMessage"]);
  await until(async () => Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count) === 0, "no work left over");
});

channelTest("tests/channels.test.ts:440", "files the agent presents reach the chat after its reply", async (_t, r) => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  r.setModel((_body, index) => [
    toolCall("write", { path: "/workspace/out/chart.png", content: png.toString("base64"), encoding: "base64", contentType: "image/png" }, index),
    toolCall("write", { path: "/workspace/out/data.csv", content: "a,b\n1,2\n" }, index),
    toolCall("present_file", { path: "/workspace/out/chart.png", caption: "Q3 chart" }, index),
    toolCall("present_file", { path: "/workspace/out/data.csv" }, index),
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

channelTest("tests/channels.test.ts:460", "send_message sends files from the agent's mounts, and refuses paths outside them", async (_t, r) => {
  const jpeg = await sharp({ create: { width: 5, height: 5, channels: 3, background: "red" } }).jpeg().toBuffer();
  r.setModel((body, index) => {
    const photo = /\[File (\/workspace\/uploads\/[^ ]+\/photo\.jpg) /.exec(lastUser(body))?.[1];
    const send = (args: object) => toolCall("send_message", args, index);
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
  // Once (CI, 89d1781) the photo went out with no bytes: say where they were lost if it happens again.
  const photo = /\[File (\/workspace\/uploads\/[^ ]+\/photo\.jpg)[^\]]*\]/.exec(lastUser(r.model.bodies[1]))?.[0];
  const trail = () => JSON.stringify({ photo, sent: r.tg.calls.filter(call => call.method.startsWith("send")).map(call => call.method) });
  await until(() => r.tg.sentFiles(ada.id).length === 1, `the photo (${trail()})`);
  assert.deepEqual(r.tg.sentFiles(ada.id), [{ method: "sendPhoto", name: "photo.jpg", caption: undefined, data: jpeg.toString() }], trail());
  const order = r.tg.calls.map(call => call.method).filter(method => method === "sendMessage" || method === "sendPhoto");
  assert.deepEqual(order, ["sendMessage", "sendPhoto", "sendMessage"]);
});

channelTest("tests/channels.test.ts:485", "send_message reaches the chat mid-turn, and tools see who is asking", async (t, r) => {
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
  r.setModel((_body, index) => {
    if (index === 0) return { role: "assistant", tool_calls: [{ index: 0, id: "call_update", type: "function", function: { name: "send_message", arguments: JSON.stringify({ text: "Working on it…" }) } }] };
    if (index === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "orders__lookup", arguments: "{}" } }] };
    return { role: "assistant", content: "All done." };
  });
  const definition = (await r.call("/v1/definitions", { body: { name: "Orders", mcpServers: [{ name: "orders", url: `${mcpUrl}/mcp`, exposure: "direct" }] } })).json;
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ada"] }, definition: definition.id });
  await r.deliver(channel, secret, from(ada, "check my order"));
  await until(() => r.tg.sent(ada.id).includes("All done."), "the final reply");
  assert.deepEqual(r.tg.sent(ada.id), ["Working on it…", "All done."]);
  assert.equal(r.model.bodies[0].tools.some((tool: any) => tool.function.name === "send_message"), true);
  const tool = r.model.bodies[1].messages.find((message: any) => message.role === "tool");
  assert.match(tool.content, /sent/);
  assert.deepEqual(seen, [{ channel: { id: channel.id, type: "telegram" }, conversationId: "42", sender: { id: "42", username: "ada", name: "Ada" } }]);
}, { env: { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" } });

channelTest("tests/channels.test.ts:517", "a channel's agents are made from its definition; one created without gets an empty one of its own", async (_t, r) => {
  r.setModel(body => ({ role: "assistant", content: `system: ${body.messages[0].content.includes("Pirate") ? "pirate" : "plain"}` }));
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

// The original ran two scanners over a bare Channels; here the reply of a real turn is sent while Telegram fails.
channelTest("tests/channels.test.ts:540", "an outbound message that fails is retried, and delivered exactly once across two scanners", async (_t, r) => {
  const reply = `${"x".repeat(4090)}\n${"y".repeat(10)}`;
  r.setModel(() => ({ role: "assistant", content: reply }));
  const { channel, secret } = await r.createChannel({ access: { public: true } });
  r.tg.state.failSends = 1;
  await r.deliver(channel, secret, from(ada, "go"));
  await until(() => r.tg.calls.some(entry => entry.method === "sendMessage:failed"), "the failed send");
  await until(() => r.tg.sent("42").length >= 2, "the retried reply");
  await sleep(1500);
  assert.deepEqual(r.tg.sent("42"), ["x".repeat(4090), "y".repeat(10)]);
  await until(async () => Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count) === 0, "no work left over");
});

// The original drained the queue from two nodes; here a backlog is drained by whatever scans the backend runs, and each message must go once.
channelTest("tests/channels.test.ts:630", "a backlog of outbound messages is sent exactly once when two nodes on separate connections drain it", async (_t, r) => {
  r.setModel(body => ({ role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` }));
  const { channel, secret } = await r.createChannel({ access: { public: true } });
  // Workers scan when work comes due, not on a timer: a failed send's retry gives them one, as ECS's loop would.
  r.tg.state.failSends = 1;
  await r.deliver(channel, secret, from(bob, "go"));
  await until(() => r.tg.calls.some(entry => entry.method === "sendMessage:failed"), "the failed send");
  const now = Date.now();
  const items = Array.from({ length: 40 }, (_, index) => ({ id: `out_${index}`, channel: channel.id, tenant: "alice", conversationId: "42", createdAt: now, state: "sending", text: `message ${index}`, sent: 0, attempts: 0 }));
  await r.channelQuery(`insert into channel_items (id, item, due) values ${items.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(", ")}`,
    items.flatMap(item => [item.id, JSON.stringify(item), now]));
  await until(async () => Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count) === 0, "the backlog drained");
  await sleep(500);
  assert.deepEqual(r.tg.sent("42").sort(), Array.from({ length: 40 }, (_, index) => `message ${index}`).sort());
  assert.equal(Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count), 0);
});

// The original fed a scripted run record to a bare Channels; here the runtime itself crashes mid-turn.
channelTest("tests/channels.test.ts:655", "a turn whose end no node saw (a crash) is re-checked and answered once", async (_t, r) => {
  // The turn's first model call never returns; after the crash the replacement answers (a restart also restarts the call count).
  let crashed = false;
  r.setModel(() => crashed ? { role: "assistant", content: "Recovered." } : { wait: new Promise(() => {}) });
  const { channel, secret } = await r.createChannel({ access: { public: true } });
  assert.equal(await r.deliver(channel, secret, from(ada, "are you there?"), 1), 200);
  await until(() => r.model.bodies.length === 1, "the prompt reaching the model");
  assert.deepEqual(r.tg.sent(), []);

  crashed = true;
  await r.restart({ crash: true });
  await until(() => r.tg.sent("42").includes("Recovered."), "the recovered reply", 60_000);
  await sleep(1500);
  assert.deepEqual(r.tg.sent("42"), ["Recovered."]);
  await until(async () => Number((await r.channelQuery("select count(*) as count from channel_items")).rows[0].count) === 0, "no work left over");
  // Telegram retrying the update now finds it handled.
  const answered = r.model.bodies.length;
  assert.equal(await r.deliver(channel, secret, from(ada, "are you there?"), 1), 200);
  await sleep(500);
  assert.equal(r.model.bodies.length, answered);
  assert.deepEqual(r.tg.sent("42"), ["Recovered."]);
}, { env: { AGENT_LEASE_TTL_MS: "1500", AGENT_CHANNEL_RECHECK_MS: "3000" } });

contractTest("channels", "tests/channels.test.ts:695", "replies split at line and word breaks within the limit", () => {
  assert.deepEqual(chunks("short", 10), ["short"]);
  assert.deepEqual(chunks("aaaa bbbb cccc", 10), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(chunks("aaa\nbbbbbb cc", 10), ["aaa\nbbbbbb", "cc"]);
  assert.deepEqual(chunks("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.ok(chunks("😀".repeat(10), 5).every(part => !/[\uD800-\uDBFF]$/.test(part)));
});

channelTest("tests/channels.test.ts:703", "a channel asks the agent's questions and approvals as messages; the asker's reply answers, anything else is a new message", async (_t, r) => {
  const ask = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU", description: "Frankfurt" }, { label: "US" }] }] };
  r.setModel(body => {
    const last = body.messages.at(-1);
    if (last.role === "tool" && JSON.parse(last.content).answers["Which region?"]) return { role: "assistant", content: `Deploying to ${JSON.parse(last.content).answers["Which region?"]}` };
    if (last.role === "tool") return { role: "assistant", content: `Answers: ${body.messages.filter((message: any) => message.role === "tool").slice(-2).map((message: any) => Object.values(JSON.parse(message.content).answers)[0]).join(", ")}` };
    const twice = (question: string, index: number) => ({ index, id: `call_${question}`, type: "function", function: { name: "ask_user", arguments: JSON.stringify({ questions: [{ question, header: "Q", options: [{ label: "Yes" }, { label: "No" }] }] }) } });
    if (/twice/.test(lastUser(body))) return { role: "assistant", tool_calls: [twice("First?", 0), twice("Second?", 1)] };
    return /deploy/.test(lastUser(body)) ? { role: "assistant", content: "One question first.", tool_calls: [{ index: 0, id: `call_${body.messages.length}`, type: "function", function: { name: "ask_user", arguments: JSON.stringify(ask) } }] }
      : { role: "assistant", content: `echo: ${lastUser(body).split("\n").at(-1)}` };
  });
  const definition = (await r.call("/v1/definitions", { body: { name: "Deployer", builtins: ["ask_user"] } })).json;
  const { channel, secret } = await r.createChannel({ access: { allow: ["@ada", "@bob"] }, definition: definition.id });

  assert.equal(await r.deliver(channel, secret, from(ada, "deploy")), 200);
  await until(() => r.tg.sent(ada.id).length === 1, "the question");
  assert.equal(r.tg.sent(ada.id)[0], "One question first.\n\nWhich region?\n1. EU — Frankfurt\n2. US");
  assert.equal(await r.deliver(channel, secret, from(ada, "2")), 200);
  await until(() => r.tg.sent(ada.id).length === 2, "the resumed reply");
  assert.equal(r.tg.sent(ada.id)[1], "Deploying to US");

  // In a group, only whoever asked for the deployment answers; someone else's message is a new one.
  const group = -100;
  assert.equal(await r.deliver(channel, secret, from(ada, "deploy", group)), 200);
  await until(() => r.tg.sent(group).length === 1, "the question in the group");
  assert.equal(await r.deliver(channel, secret, from(bob, "1", group)), 200);
  await until(() => r.tg.sent(group).length === 2, "bob's message, answered as a new one");
  assert.equal(r.tg.sent(group)[1], "echo: 1");
  const agent = (await r.channelQuery("select agent from channel_conversations where conversation = $1", [String(group)])).rows[0].agent;
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`)).json[0].state, "superseded");

  // Several inputs are asked one message at a time.
  assert.equal(await r.deliver(channel, secret, from(bob, "ask me twice")), 200);
  await until(() => r.tg.sent(bob.id).length === 1, "the first question");
  const first = r.tg.sent(bob.id)[0].split("\n")[0];
  assert.ok(["First?", "Second?"].includes(first));
  assert.equal(await r.deliver(channel, secret, from(bob, "yes")), 200);
  await until(() => r.tg.sent(bob.id).length === 2, "the second question");
  assert.equal(r.tg.sent(bob.id)[1].split("\n")[0], first === "First?" ? "Second?" : "First?");
  assert.equal(await r.deliver(channel, secret, from(bob, "2")), 200);
  await until(() => r.tg.sent(bob.id).length === 3, "the resumed reply");
  assert.match(r.tg.sent(bob.id)[2], /^Answers: (Yes, No|No, Yes)$/);
});

contractTest("channels", "tests/channels.test.ts:747", "inputs read as messages, and only a reply that fits answers one", () => {
  const input = (kind: string, detail: object, message = "") => ({ kind, detail, message } as any);
  const approval = input("approval", { tool: "shop__delete_item", source: "shop", arguments: { id: "a" } });
  assert.equal(askText(approval), 'Approve this action? shop__delete_item (shop) with {"id":"a"}\nReply approve or deny.');
  assert.deepEqual(answerOf(approval, "Approve!"), { action: "accept" });
  assert.deepEqual(answerOf(approval, "no"), { action: "decline" });
  assert.equal(answerOf(approval, "approve it, sure"), undefined, "only an exact reply counts");
  const url = input("url", { url: "https://crm.example.test/connect", origin: "https://crm.example.test" }, "Connect your CRM");
  assert.equal(askText(url), "Connect your CRM\nhttps://crm.example.test/connect\n(on crm.example.test)\nReply done when you have finished.");
  assert.deepEqual(answerOf(url, "done"), { action: "accept" });
  assert.equal(answerOf(url, "ok"), undefined);
  const questions = input("question", { questions: [
    { question: "Which region?", options: [{ label: "EU" }, { label: "US" }], multiSelect: false, allowOther: false },
    { question: "Which days?", options: [{ label: "Mon" }, { label: "Tue" }], multiSelect: true, allowOther: true },
  ] });
  assert.match(askText(questions), /Reply with one line per question, in order\.$/);
  assert.deepEqual(answerOf(questions, "eu\n1, 2"), { action: "accept", content: { answers: { "Which region?": "EU", "Which days?": ["Mon", "Tue"] } } });
  assert.deepEqual(answerOf(questions, "2\nwhenever"), { action: "accept", content: { answers: { "Which region?": "US", "Which days?": ["whenever"] } } });
  assert.equal(answerOf(questions, "Asia\n1"), undefined);
  assert.equal(answerOf(questions, "1"), undefined);
  const confirm = input("form", { requestedSchema: { type: "object", properties: {} } }, "Delete shop?");
  assert.deepEqual(answerOf(confirm, "yes"), { action: "accept", content: {} });
  const count = input("form", { requestedSchema: { type: "object", properties: { count: { type: "integer" } } } }, "How many?");
  assert.equal(askText(count), "How many?\nReply with the count.");
  assert.deepEqual(answerOf(count, " 3 "), { action: "accept", content: { count: 3 } });
  assert.equal(answerOf(count, "three"), undefined);
});

// Node-only cases (accepted differences on Workers): they drive ECS's Channels class, claims and leases directly, as the originals do.
async function ecsChannels(t: TestContext, options: { retryBaseMs?: number; files?: ChannelFiles } = {}) {
  const tg = await fakeTelegram(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test",
    ...(options.retryBaseMs ? { retryBaseMs: options.retryBaseMs } : {}), ...(options.files ? { files: options.files } : {}),
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
  const channel = await channels.create("default", { type: "telegram", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('client_x', $1, 'default', '42')", [channel.id]);
  return { tg, db, accounts, channels, channel };
}

contractTest("channels", "tests/channels.test.ts:413", "a file that reads back shorter than its reference is never sent: the send fails, is retried, and says what came back", async t => {
  const workspace = memoryFiles();
  const { tg, db, channels } = await ecsChannels(t, { retryBaseMs: 50, files: workspace.files });
  const logged: string[] = [];
  const error = t.mock.method(console, "error", (line: string) => { logged.push(line); });
  // Its reference says 85 bytes; its volume gives back none.
  const presented = [workspace.present("/workspace/photo.jpg", Buffer.alloc(0), "image/jpeg", { size: 85 })];
  channels.hooks.runEnded!({ id: "client_x", tenant: "default" }, { id: "schedule-1", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "Here it is.", presented } } });
  await until(() => logged.filter(line => line.includes("channel_file_size_mismatch")).length === 1, "the short read");
  await until(async () => (await db.query("select item from channel_items where claimed_by is null")).rows[0]?.item.attempts === 1, "the send released for a retry");
  error.mock.restore();
  assert.deepEqual(tg.sent("42"), ["Here it is."], "the reply went; the file did not");
  assert.deepEqual(tg.sentFiles("42"), []);
  const mismatch = JSON.parse(logged.find(line => line.includes("channel_file_size_mismatch"))!);
  assert.deepEqual([mismatch.size, mismatch.read, mismatch.parts], [85, 0, [0]]);
  assert.match(logged.find(line => line.includes("channel_send_failed"))!, /"permanent":false/, "retried, not given up");
});

contractTest("channels", "tests/channels.test.ts:568", "a node whose claim on a message lapsed, and whose send then fails for good, leaves the message to the node that retook it", async t => {
  const { tg, db, accounts, channels: a } = await ecsChannels(t, { retryBaseMs: 50 });
  const b = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "b", publicUrl: "https://agents.example.test", retryBaseMs: 50,
    providers: { telegram: telegram({ apiUrl: tg.url }) },
    createAgent: async () => { throw new Error("unused"); }, agentId: () => "unused", live: async () => true, submit: async () => { throw new Error("unused"); },
  });
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

contractTest("channels", "tests/channels.test.ts:599", "a node that lost an agent sends nothing more for it", async t => {
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
