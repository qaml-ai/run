import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { inboundItemId } from "../../../src/core/channels/channels.ts";
import { PNG, pdfBytes } from "../../file-fixtures.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { contractTest, OPERATOR, sleep, toolCall, until } from "../support.ts";
import { asked, fakeSlack, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, slackChannels, uploaded, type FakeSlack } from "../channel-service-fakes.ts";

/** Slack channels on either backend: the fake Web API stands in for Slack, the fixture's model for the agent's. */
type R = ContractFixture & { api: FakeSlack } & ReturnType<typeof slackChannels>;
function channelTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions = {}) {
  let api: FakeSlack;
  contractTest("channels", source, name, (t, fixture) => body(t, Object.assign(fixture, { api }, slackChannels(fixture))), {
    ...options, env: { AGENT_CHANNEL_RETRY_MS: "100", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", ...options.env },
    prepare: async t => {
      api = await fakeSlack(t);
      api.hosted.set("/files/cat.png", { data: PNG, type: "image/png" });
      return { AGENT_SLACK_API_URL: api.url, ...await options.prepare?.(t) };
    },
  });
}

/** The agent's answer to what it was asked: the last line of the words, with markup characters for Slack to escape. */
const echo = (body: any) => ({ role: "assistant", content: `re: ${asked(body).text.split("\n").at(-1)} <ok> & done` });
const agents = (r: R) => r.call("/v1/agents").then(response => response.json as { id: string; name: string }[]);
const itemsLeft = (r: R) => r.channelQuery("select count(*) as count from channel_items").then(result => Number(result.rows[0].count));

channelTest("tests/channels-slack.test.ts:113", "a Slack channel checks its credentials, keeps them sealed, and gives the URL to paste into the app", async (_t, r) => {
  const channel = await r.createChannel();
  assert.equal(channel.webhookUrl, `https://agents.example.test/channels/slack/${channel.id}`);
  assert.deepEqual(channel.account, { id: "UBOT", username: "fixture_bot", teamId: "T1", team: "Fixture" });
  assert.deepEqual(channel.credentials, { botToken: "xoxb-…oken", signingSecret: `…${SLACK_SIGNING_SECRET.slice(-4)}` });
  assert.equal(channel.name, "Slack @fixture_bot");
  const stored = JSON.stringify((await r.channelQuery("select channel from channels")).rows[0].channel);
  assert.ok(!stored.includes(SLACK_BOT_TOKEN) && !stored.includes(SLACK_SIGNING_SECRET), "credentials are stored sealed");

  const missing = await r.call("/v1/channels", { body: { type: "slack", credentials: { botToken: SLACK_BOT_TOKEN } } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /signingSecret/);
  const wrong = await r.call("/v1/channels", { body: { type: "slack", credentials: { botToken: "xoxb-9999-wrong-token-here", signingSecret: SLACK_SIGNING_SECRET } } });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.error, /invalid_auth/);
});

channelTest("tests/channels-slack.test.ts:126", "Slack's URL check is answered only when signed, and stale or forged deliveries are refused", async (_t, r) => {
  const channel = await r.createChannel();
  const challenge = { type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" };
  const answered = await r.post(channel, challenge);
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { challenge: challenge.challenge });
  assert.equal((await r.post(channel, challenge, { secret: "0".repeat(32) })).status, 401);
  assert.equal((await r.post(channel, challenge, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  const unsigned = await fetch(`${r.base}/channels/slack/${channel.id}`, { method: "POST", body: JSON.stringify(challenge) });
  assert.equal(unsigned.status, 401);
});

channelTest("tests/channels-slack.test.ts:138", "a mention starts a thread with its own agent; replies in it continue; DMs are their own conversation", async (_t, r) => {
  r.setModel(echo);
  const channel = await r.createChannel();
  assert.equal((await r.event(channel, { type: "app_mention", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" })).status, 200);
  await until(() => r.api.posts().length === 1, "the threaded reply");
  // The answer goes into a thread on the mention, escaped for Slack.
  assert.deepEqual(r.api.posts()[0], { channel: "C1", thread_ts: "100.0001", text: "re: what's up? &lt;ok&gt; &amp; done", unfurl_links: false, unfurl_media: false });
  assert.equal(asked(r.model.bodies[0]).text, "what's up?");
  assert.deepEqual(asked(r.model.bodies[0]).from, { id: "slack:U_ADA" });

  // Slack sends the same message as `message` too, and retries: it is answered once.
  await r.event(channel, { type: "message", channel_type: "channel", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" });
  await r.event(channel, { type: "app_mention", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" });
  // A reply in the thread without a mention reaches the same agent.
  await r.event(channel, { type: "message", channel_type: "channel", channel: "C1", ts: "101.0001", thread_ts: "100.0001", text: "and then?" });
  await until(() => r.api.posts().length === 2, "the reply in the thread");
  assert.equal(r.model.bodies.length, 2);
  assert.equal((await agents(r)).length, 1, "the thread continues with the same agent");
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "user").length, 2);
  assert.deepEqual({ ...r.api.posts()[1], text: undefined }, { channel: "C1", thread_ts: "100.0001", text: undefined, unfurl_links: false, unfurl_media: false });

  // Threads the bot was never asked into, plain channel chatter, bots and edits are ignored.
  await r.event(channel, { type: "message", channel_type: "channel", channel: "C1", ts: "200.0001", thread_ts: "150.0001", text: "unrelated thread" });
  await r.event(channel, { type: "message", channel_type: "channel", channel: "C1", ts: "201.0001", text: "chatter" });
  await r.event(channel, { type: "message", channel_type: "channel", channel: "C1", ts: "202.0001", thread_ts: "100.0001", text: "bot says", bot_id: "B1" });
  await r.event(channel, { type: "message", subtype: "message_changed", channel_type: "channel", channel: "C1", ts: "203.0001", thread_ts: "100.0001", text: "edited" });
  // Someone not on the allowlist is ignored even when mentioning the bot.
  await r.event(channel, { type: "app_mention", channel: "C1", ts: "204.0001", text: "<@UBOT> hi", user: "U_EVE" });

  // A DM is one conversation, answered in place.
  await r.event(channel, { type: "message", channel_type: "im", channel: "D1", ts: "300.0001", text: "hello in private" });
  await until(() => r.api.posts().length === 3, "the DM reply");
  assert.deepEqual(r.api.posts()[2].channel, "D1");
  assert.equal("thread_ts" in r.api.posts()[2], false);
  assert.equal((await agents(r)).length, 2, "the DM is another agent");
  assert.equal(r.model.bodies[2].messages.filter((message: any) => message.role === "user").length, 1);
  await sleep(500);
  assert.equal(r.model.bodies.length, 3);
  const conversations = (await r.channelQuery("select conversation from channel_conversations order by conversation")).rows.map(row => row.conversation);
  assert.deepEqual(conversations, ["C1-100.0001", "D1"]);
});

channelTest("tests/channels-slack.test.ts:177", "Slack files of any type are fetched with the bot token from Slack's file host only, into the agent's workspace", async (_t, r) => {
  r.setModel(echo);
  const channel = await r.createChannel();
  const pdf = pdfBytes(["Quarterly report"]);
  r.api.hosted.set("/files/doc.pdf", { data: pdf, type: "application/pdf" });
  await r.event(channel, {
    type: "message", subtype: "file_share", channel_type: "im", channel: "D1", ts: "1.0001", text: "look",
    files: [
      { name: "cat.png", mimetype: "image/png", size: PNG.length, url_private: `${r.api.url}/files/cat.png` },
      { name: "doc.pdf", mimetype: "application/pdf", size: pdf.length, url_private_download: `${r.api.url}/files/doc.pdf` },
      { name: "steal.png", mimetype: "image/png", size: PNG.length, url_private: "https://attacker.example/steal.png" },
      { name: "huge.mov", mimetype: "video/quicktime", size: 30 * 1024 * 1024, url_private: `${r.api.url}/files/huge.mov` },
      { name: "gone.txt", mimetype: "text/plain", size: 5, url_private: `${r.api.url}/files/gone.txt` },
      { name: "hidden.txt", mode: "hidden_by_limit" },
    ],
  });
  await until(() => r.model.bodies.length === 1, "the prompt");
  const item = inboundItemId(channel.id, "D1:1.0001");
  const [agent] = await agents(r);
  const workspace = await uploaded(r.call, r.base, OPERATOR, agent!.id, item);
  assert.deepEqual(workspace.listed.map(file => [file.path, file.contentType]), [[`/uploads/${item}/cat.png`, "image/png"], [`/uploads/${item}/doc.pdf`, "application/pdf"]]);
  assert.deepEqual(await workspace.read(`/uploads/${item}/doc.pdf`), pdf);
  const prompt = asked(r.model.bodies[0]);
  assert.equal(prompt.text, [
    "look", "(file steal.png could not be downloaded, not attached)", "(file huge.mov too large, not attached)",
    "(file gone.txt could not be downloaded, not attached)", "(file hidden.txt could not be downloaded, not attached)",
  ].join("\n"));
  // The model is shown the two files, as it is any attachment; the transcript keeps references, not bytes.
  assert.deepEqual(prompt.rest.map((block: any) => block.text).filter(Boolean).map((line: string) => line.split(" (")[0]),
    [`[File /workspace/uploads/${item}/cat.png`, `[File /workspace/uploads/${item}/doc.pdf`]);
  const history = JSON.stringify((await r.call(`/v1/agents/${agent!.id}/history`)).json);
  assert.ok(!history.includes(PNG.toString("base64")), "no bytes in the transcript");
  // The token went only to Slack's host: the two files, and the one it no longer has.
  assert.deepEqual(r.api.downloads, [`Bearer ${SLACK_BOT_TOKEN}`, `Bearer ${SLACK_BOT_TOKEN}`, `Bearer ${SLACK_BOT_TOKEN}`]);
});

channelTest("tests/channels-slack.test.ts:206", "a file without a message is a prompt of its own, and a sign-in page is not taken for the file", async (_t, r) => {
  r.setModel(echo);
  const channel = await r.createChannel();
  r.api.hosted.set("/files/notes.txt", { data: Buffer.from("<html>sign in</html>"), type: "text/html" });
  await r.event(channel, { type: "message", subtype: "file_share", channel_type: "im", channel: "D1", ts: "2.0001", text: "", files: [{ name: "cat.png", mimetype: "image/png", url_private: `${r.api.url}/files/cat.png` }] });
  await until(() => r.model.bodies.length === 1, "the prompt");
  assert.equal(asked(r.model.bodies[0]).text, "(sent a file)");
  await r.event(channel, { type: "message", subtype: "file_share", channel_type: "im", channel: "D1", ts: "3.0001", text: "", files: [{ name: "notes.txt", mimetype: "text/plain", url_private: `${r.api.url}/files/notes.txt` }] });
  await until(() => r.model.bodies.length === 2, "the second prompt");
  const second = asked(r.model.bodies[1]);
  assert.equal(second.text, "(file notes.txt could not be downloaded, not attached)");
  assert.equal(second.rest.length, 0, "no file came with it");
});

channelTest("tests/channels-slack.test.ts:218", "presented files go to the thread after the reply through Slack's external upload, and past the limit as a link", async (_t, r) => {
  // The agent makes a chart and a table and presents both; the runtime is told Slack takes files only up to 8 bytes, so the table goes as a link.
  r.setModel((_body, index) => [
    toolCall("write", { path: "/workspace/chart.png", content: "chart" }),
    toolCall("write", { path: "/workspace/dump.csv", content: "a,b\n1,2\n3,4\n" }),
    toolCall("present_file", { path: "/workspace/chart.png", caption: "The chart" }),
    toolCall("present_file", { path: "/workspace/dump.csv" }, "call_present_dump"),
  ][index] ?? { role: "assistant", content: "Here is the chart." });
  const channel = await r.createChannel();
  await r.event(channel, { type: "app_mention", channel: "C1", ts: "100.0001", text: "<@UBOT> chart please" });
  await until(() => r.api.calls.filter(call => call.method === "chat.postMessage").length === 2, "the reply and the link");
  const methods = r.api.calls.map(call => call.method).filter(method => method !== "auth.test");
  assert.deepEqual(methods, ["chat.postMessage", "files.getUploadURLExternal", "files.completeUploadExternal", "chat.postMessage"]);
  assert.equal(r.api.posts()[0].text, "Here is the chart.");
  const [asked_, completed] = [r.api.calls.find(call => call.method === "files.getUploadURLExternal")!, r.api.calls.find(call => call.method === "files.completeUploadExternal")!];
  assert.deepEqual(asked_.body, { filename: "chart.png", length: "5" });
  const id = completed.body.files[0].id;
  assert.deepEqual(completed.body, { files: [{ id, title: "chart.png" }], channel_id: "C1", thread_ts: "100.0001", initial_comment: "The chart" });
  assert.deepEqual(r.api.uploads.get(id), Buffer.from("chart"));
  const link = r.api.posts()[1];
  assert.equal(link.thread_ts, "100.0001");
  assert.match(link.text, /^dump\.csv \(1 KB, too large to send here; the link works for 24 hours\): https:\/\/agents\.example\.test\/\S+$/);
  await until(async () => await itemsLeft(r) === 0, "the item done");
}, { env: { AGENT_TEST_SLACK_MAX_FILE_BYTES: "8" } });

channelTest("tests/channels-slack.test.ts:238", "a Slack send to a channel that is gone is not retried", async (_t, r) => {
  r.setModel(echo);
  const channel = await r.createChannel();
  await r.event(channel, { type: "app_mention", channel: "CGONE", ts: "5.0001", text: "<@UBOT> hi" });
  await until(() => r.api.calls.some(call => call.method === "chat.postMessage"), "the send");
  await until(async () => await itemsLeft(r) === 0, "the item dropped");
  await sleep(500);
  assert.equal(r.api.calls.filter(call => call.method === "chat.postMessage").length, 1);
});
