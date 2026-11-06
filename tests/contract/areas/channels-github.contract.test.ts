import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { inboundItemId } from "../../../src/core/channels/channels.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { contractTest, OPERATOR, sleep, until } from "../support.ts";
import { asked, DIFF, fakeGitHub, GITHUB_PEM, GITHUB_WEBHOOK_SECRET, githubChannels, uploaded, type FakeGitHub } from "../channel-service-fakes.ts";

/** GitHub channels on either backend: the fake REST API stands in for GitHub, the fixture's model for the agent's. */
type R = ContractFixture & { api: FakeGitHub } & ReturnType<typeof githubChannels>;
function channelTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions = {}) {
  let api: FakeGitHub;
  contractTest("channels", source, name, (t, fixture) => body(t, Object.assign(fixture, { api }, githubChannels(fixture))), {
    ...options, env: { AGENT_CHANNEL_RETRY_MS: "100", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", ...options.env },
    prepare: async t => {
      api = await fakeGitHub(t);
      return { AGENT_GITHUB_API_URL: api.url, ...await options.prepare?.(t) };
    },
  });
}

/** Each turn the agent reviews, and says which turn it was. */
const reviewing = (r: R) => r.setModel((_body, index) => ({ role: "assistant", content: `Reviewed (${index + 1})` }));
const agents = (r: R) => r.call("/v1/agents").then(response => response.json as { id: string; name: string }[]);
const itemsLeft = (r: R) => r.channelQuery("select count(*) as count from channel_items").then(result => Number(result.rows[0].count));

channelTest("tests/channels-github.test.ts:115", "a GitHub channel checks the app's credentials with its JWT and keeps them sealed", async (_t, r) => {
  const channel = await r.createChannel();
  assert.equal(channel.webhookUrl, `https://agents.example.test/channels/github/${channel.id}`);
  assert.deepEqual(channel.account, { id: "4242", slug: "review-bot", username: "review-bot", botLogin: "review-bot[bot]", name: "Review Bot" });
  assert.equal(channel.name, "GitHub @review-bot");
  assert.deepEqual(channel.settings, {
    events: ["pull_request.opened", "pull_request.reopened", "pull_request.ready_for_review", "pull_request.synchronize", "issue_comment", "pull_request_review_comment"],
    repos: [], ignoreDrafts: true, reply: "comment", authors: "allowlist", debounceSeconds: 30,
  });
  const stored = JSON.stringify((await r.channelQuery("select channel from channels")).rows[0].channel);
  assert.ok(!stored.includes("PRIVATE KEY") && !stored.includes(GITHUB_WEBHOOK_SECRET), "credentials are stored sealed");
  const create = (credentials: object) => r.call("/v1/channels", { body: { type: "github", credentials } });
  const wrongApp = await create({ appId: "1", privateKey: GITHUB_PEM, webhookSecret: "x" });
  assert.equal(wrongApp.status, 422);
  assert.match(wrongApp.json.error, /rejected the app credentials/);
  const noKey = await create({ appId: "4242", privateKey: "nope", webhookSecret: "x" });
  assert.equal(noKey.status, 422);
  assert.match(noKey.json.error, /privateKey/);
  const update = (settings: object) => r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings } });
  const shout = await update({ reply: "shout" });
  assert.equal(shout.status, 400);
  assert.match(shout.json.error, /reply is comment or none/);
  const push = await update({ events: ["push"] });
  assert.equal(push.status, 400);
  assert.match(push.json.error, /settings.events/);
  const updated = await update({ repos: ["acme/*"] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.settings.repos, ["acme/*"]);
  assert.equal(updated.json.settings.reply, "comment", "settings merge over what is stored");
});

channelTest("tests/channels-github.test.ts:135", "GitHub deliveries must be signed; pings are answered", async (_t, r) => {
  reviewing(r);
  const channel = await r.createChannel();
  const ping = await r.post(channel, "ping", { zen: "Keep it logically awesome.", hook_id: 1, ...r.common });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), {});
  assert.equal((await r.pullRequest(channel, "opened")).status, 200);
  assert.equal((await r.post(channel, "pull_request", { action: "opened", pull_request: {}, ...r.common }, { secret: "wrong" })).status, 401);
  const unsigned = await fetch(`${r.base}/channels/github/${channel.id}`, { method: "POST", body: "{}" });
  assert.equal(unsigned.status, 401);
});

channelTest("tests/channels-github.test.ts:146", "an opened pull request starts a turn with its diff attached, and the reply is a comment on it", async (_t, r) => {
  reviewing(r);
  const channel = await r.createChannel();
  const delivery = randomUUID();
  await r.post(channel, "pull_request", { action: "opened", pull_request: r.pull(), ...r.common }, { delivery });
  await until(() => r.api.comments.length === 1, "the comment");
  assert.deepEqual(r.api.comments[0], { path: "/repos/acme/widgets/issues/12/comments", body: "Reviewed (1)" });
  const prompt = asked(r.model.bodies[0]);
  assert.match(prompt.text, /^\[From GitHub\]\n@ada opened pull request acme\/widgets#12: Add widgets/);
  assert.match(prompt.text, /Base: main ← head: widgets \(abcdef123456\)/);
  assert.match(prompt.text, /Adds the widget\./);
  const [agent] = await agents(r);
  const workspace = await uploaded(r.call, r.base, OPERATOR, agent!.id, inboundItemId(channel.id, delivery));
  assert.equal(workspace.listed.length, 1);
  assert.match(workspace.listed[0]!.path, /\/pr-12\.diff$/);
  assert.equal((await workspace.read(workspace.listed[0]!.path)).toString(), DIFF);
  assert.ok(prompt.rest.some((block: any) => /pr-12\.diff/.test(block.text ?? "")), "the model is told of the attached diff");
  // One installation token served the diff, the name lookup and the comment.
  assert.equal(r.api.tokensIssued.length, 1);

  // A retried delivery is dropped; a mention in a comment reaches the same agent.
  const reopened = { action: "reopened", pull_request: { number: 12, title: "Add widgets", base: {}, head: {} }, ...r.common };
  await r.post(channel, "pull_request", reopened, { delivery: randomUUID() });
  const again = randomUUID();
  await r.post(channel, "pull_request", reopened, { delivery: again });
  await r.post(channel, "pull_request", reopened, { delivery: again });
  await until(() => r.api.comments.length === 3, "the next comments");
  await r.comment(channel, "@review-bot can you look at x.ts?");
  await until(() => r.api.comments.length === 4, "the last comment");
  await sleep(500);
  assert.equal(r.model.bodies.length, 4, "a retried delivery is handled once");
  assert.equal((await agents(r)).length, 1, "the same pull request reuses its agent");
  assert.equal(r.model.bodies[3].messages.filter((message: any) => message.role === "user").length, 4);
  assert.match(asked(r.model.bodies[3]).text, /@ada commented on pull request acme\/widgets#12 \(Add widgets\):/);
  const conversations = (await r.channelQuery("select conversation from channel_conversations")).rows.map(row => row.conversation);
  assert.deepEqual(conversations, ["9-77-12"]);
});

channelTest("tests/channels-github.test.ts:177", "filters: the app's own activity, drafts, unmentioned comments, other repos, events not chosen and strangers start nothing", async (_t, r) => {
  reviewing(r);
  const channel = await r.createChannel({ settings: { repos: ["acme/widgets"] } });
  await r.pullRequest(channel, "opened", {}, { sender: { id: 5, login: "review-bot[bot]", type: "Bot" } });
  await r.comment(channel, "@review-bot again", { sender: { id: 5, login: "review-bot[bot]", type: "Bot" } });
  await r.pullRequest(channel, "opened", { draft: true });
  await r.comment(channel, "just talking among ourselves");
  await r.comment(channel, "cc @review-bottle");
  await r.pullRequest(channel, "opened", {}, { repository: { id: 78, full_name: "acme/gadgets" } });
  await r.pullRequest(channel, "closed");
  await r.pullRequest(channel, "opened", {}, { sender: { id: 6, login: "eve", type: "User" } });
  await sleep(1000);
  assert.equal(r.model.bodies.length, 0);
  // A draft marked ready does start one.
  await r.pullRequest(channel, "ready_for_review");
  await until(() => r.model.bodies.length === 1, "the ready-for-review turn");
});

channelTest("tests/channels-github.test.ts:194", "with authors: members, a repository member needs no allowlist entry; contributors still do", async (_t, r) => {
  reviewing(r);
  const channel = await r.createChannel({ settings: { authors: "members" } });
  await r.comment(channel, "@review-bot hi", { sender: { id: 7, login: "grace", type: "User" }, comment: { body: "@review-bot hi", author_association: "MEMBER" } });
  await until(() => r.model.bodies.length === 1, "the member's turn");
  await r.comment(channel, "@review-bot hi", { sender: { id: 8, login: "mallory", type: "User" }, comment: { body: "@review-bot hi", author_association: "CONTRIBUTOR" } });
  await sleep(500);
  assert.equal(r.model.bodies.length, 1);
});

channelTest("tests/channels-github.test.ts:203", "pushes in quick succession start one turn, on the latest", async (_t, r) => {
  reviewing(r);
  // The original scanned past the 30 s debounce; here the channel's own debounce is short and the runtime's wake finds it due.
  const channel = await r.createChannel({ settings: { debounceSeconds: 2 } });
  await r.pullRequest(channel, "synchronize", { head: { ref: "widgets", sha: "1111111111111111" } }, { before: "0000", after: "1111111111111111" });
  await r.pullRequest(channel, "synchronize", { head: { ref: "widgets", sha: "2222222222222222" } }, { before: "1111", after: "2222222222222222" });
  await sleep(200);
  assert.equal(r.model.bodies.length, 0, "waiting out the debounce");
  await until(() => r.api.comments.length === 1, "the one comment", 30_000);
  await sleep(500);
  assert.equal(r.model.bodies.length, 1);
  assert.match(asked(r.model.bodies[0]).text, /Head is now 222222222222/);
});

channelTest("tests/channels-github.test.ts:216", "with reply: none the agent's reply is not posted", async (_t, r) => {
  reviewing(r);
  const channel = await r.createChannel({ settings: { reply: "none" } });
  await r.pullRequest(channel, "opened");
  await until(() => r.model.bodies.length === 1, "the turn");
  await until(async () => await itemsLeft(r) === 0, "the item to finish");
  assert.equal(r.api.comments.length, 0);
});
