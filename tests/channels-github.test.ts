import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels } from "../src/channels.ts";
import { github } from "../src/channels-github.ts";
import { testDatabase } from "./database.ts";
import { memoryFiles } from "./channel-files.ts";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const WEBHOOK_SECRET = "fixture-webhook-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const DIFF = "diff --git a/x.ts b/x.ts\n+hello\n";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 10_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A local stand-in for GitHub's REST API; the real one is never called. */
async function fakeGitHub(t: T) {
  const comments: { path: string; body: string }[] = [];
  const tokensIssued: string[] = [];
  const diffs: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const answer = (value: object, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (req.url === "/app" || req.url!.startsWith("/app/")) {
      // The app's JWT, signed with its private key.
      const [header, payload, signature] = auth.split(".");
      if (!signature || !verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) return answer({ message: "Bad credentials" }, 401);
      if (JSON.parse(Buffer.from(payload, "base64url").toString()).iss !== "4242") return answer({ message: "Bad credentials" }, 401);
      if (req.url === "/app") return answer({ id: 4242, slug: "review-bot", name: "Review Bot" });
      const installation = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url!)?.[1];
      const token = `ghs_${installation}_${randomUUID()}`;
      tokensIssued.push(token);
      return answer({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (!tokensIssued.includes(auth)) return answer({ message: "Bad credentials" }, 401);
    if (req.url === "/repositories/77") return answer({ id: 77, full_name: "acme/widgets" });
    if (req.url === "/repos/acme/widgets/pulls/12" && req.headers.accept === "application/vnd.github.diff") {
      diffs.push(req.url);
      return res.writeHead(200, { "Content-Type": "text/plain" }).end(DIFF);
    }
    const comment = /^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(req.url!);
    if (comment && req.method === "POST") { comments.push({ path: req.url!, body: body.body }); return answer({ id: comments.length }, 201); }
    answer({ message: "Not Found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, comments, tokensIssued, diffs };
}

async function setup(t: T, settings?: Record<string, unknown>) {
  const api = await fakeGitHub(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const prompts: { agent: string; text: string; files?: { path: string }[] }[] = [];
  const workspace = memoryFiles();
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test", files: workspace.files,
    providers: { github: github({ apiUrl: api.url }) },
    createAgent: async (_tenant, _params, key) => ({ id: `client_${sha(key).slice(0, 40)}` }), agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    submit: async (agent, tenant, request) => {
      const params = request.params as { text: string; files?: { path: string }[] };
      prompts.push({ agent, text: params.text, ...(params.files ? { files: params.files } : {}) });
      setImmediate(() => channels.hooks.runEnded!({ id: agent, tenant }, {
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: `Reviewed (${prompts.length})` } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
  });
  const channel = await channels.create("default", {
    type: "github", credentials: { appId: "4242", privateKey: PEM, webhookSecret: WEBHOOK_SECRET }, access: { allow: ["ada"] }, ...(settings ? { settings } : {}),
  });
  /** Deliver an event as GitHub would: signed over the raw body, with its type and delivery id in headers. */
  const post = (event: string, payload: object, options: { secret?: string; delivery?: string } = {}) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", options.secret ?? WEBHOOK_SECRET).update(body).digest("hex")}`;
    return channels.app.request(`/channels/github/${channel.id}`, {
      method: "POST", body,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": options.delivery ?? randomUUID(), "X-Hub-Signature-256": signature },
    });
  };
  const common = { installation: { id: 9 }, repository: { id: 77, full_name: "acme/widgets" }, sender: { id: 1, login: "ada", type: "User" } };
  const pull = (fields: Record<string, unknown> = {}) => ({
    number: 12, title: "Add widgets", body: "Adds the widget.", html_url: "https://github.com/acme/widgets/pull/12", draft: false,
    user: { login: "ada" }, author_association: "CONTRIBUTOR", base: { ref: "main" }, head: { ref: "widgets", sha: "abcdef1234567890" }, ...fields,
  });
  const pullRequest = (action: string, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    post("pull_request", { action, pull_request: pull(fields), ...common, ...extra });
  const comment = (body: string, extra: Record<string, unknown> = {}) => post("issue_comment", {
    action: "created", issue: { number: 12, title: "Add widgets", pull_request: {} },
    comment: { body, html_url: "https://github.com/acme/widgets/pull/12#issuecomment-1", author_association: "CONTRIBUTOR" }, ...common, ...extra,
  });
  return { api, db, channels, channel, prompts, post, pullRequest, comment, workspace, common };
}

test("a GitHub channel checks the app's credentials with its JWT and keeps them sealed", async t => {
  const r = await setup(t);
  assert.equal(r.channel.webhookUrl, `https://agents.example.test/channels/github/${r.channel.id}`);
  assert.deepEqual(r.channel.account, { id: "4242", slug: "review-bot", username: "review-bot", botLogin: "review-bot[bot]", name: "Review Bot" });
  assert.equal(r.channel.name, "GitHub @review-bot");
  assert.deepEqual(r.channel.settings, {
    events: ["pull_request.opened", "pull_request.reopened", "pull_request.ready_for_review", "pull_request.synchronize", "issue_comment", "pull_request_review_comment"],
    repos: [], ignoreDrafts: true, reply: "comment", authors: "allowlist", debounceSeconds: 30,
  });
  const stored = JSON.stringify((await r.db.query("select channel from channels")).rows[0].channel);
  assert.ok(!stored.includes("PRIVATE KEY") && !stored.includes(WEBHOOK_SECRET), "credentials are stored sealed");
  await assert.rejects(r.channels.create("default", { type: "github", credentials: { appId: "1", privateKey: PEM, webhookSecret: "x" } }), /rejected the app credentials/);
  await assert.rejects(r.channels.create("default", { type: "github", credentials: { appId: "4242", privateKey: "nope", webhookSecret: "x" } }), /privateKey/);
  await assert.rejects(r.channels.update("default", r.channel.id, { settings: { reply: "shout" } }), /reply is comment or none/);
  await assert.rejects(r.channels.update("default", r.channel.id, { settings: { events: ["push"] } }), /settings.events/);
  const updated = await r.channels.update("default", r.channel.id, { settings: { repos: ["acme/*"] } });
  assert.deepEqual((updated.settings as { repos: string[] }).repos, ["acme/*"]);
  assert.equal((updated.settings as { reply: string }).reply, "comment", "settings merge over what is stored");
});

test("GitHub deliveries must be signed; pings are answered", async t => {
  const r = await setup(t);
  const ping = await r.post("ping", { zen: "Keep it logically awesome.", hook_id: 1, ...r.common });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), {});
  assert.equal((await r.pullRequest("opened")).status, 200);
  assert.equal((await r.post("pull_request", { action: "opened", pull_request: {}, ...r.common }, { secret: "wrong" })).status, 401);
  const unsigned = await r.channels.app.request(`/channels/github/${r.channel.id}`, { method: "POST", body: "{}" });
  assert.equal(unsigned.status, 401);
});

test("an opened pull request starts a turn with its diff attached, and the reply is a comment on it", async t => {
  const r = await setup(t);
  const delivery = randomUUID();
  await r.pullRequest("opened", {}, {});
  await until(() => r.api.comments.length === 1, "the comment");
  assert.deepEqual(r.api.comments[0], { path: "/repos/acme/widgets/issues/12/comments", body: "Reviewed (1)" });
  const [prompt] = r.prompts;
  assert.match(prompt.text, /^\[From GitHub\]\n@ada opened pull request acme\/widgets#12: Add widgets/);
  assert.match(prompt.text, /Base: main ← head: widgets \(abcdef123456\)/);
  assert.match(prompt.text, /Adds the widget\./);
  assert.equal(prompt.files?.length, 1);
  assert.match(prompt.files![0].path, /\/pr-12\.diff$/);
  assert.equal(r.workspace.saved.get(prompt.files![0].path)?.data.toString(), DIFF);
  // One installation token served the diff, the name lookup and the comment.
  assert.equal(r.api.tokensIssued.length, 1);

  // A retried delivery is dropped; a mention in a comment reaches the same agent.
  const reopened = { action: "reopened", pull_request: { number: 12, title: "Add widgets", base: {}, head: {} }, ...r.common };
  await r.post("pull_request", reopened, { delivery });
  await r.post("pull_request", reopened, { delivery });
  await until(() => r.api.comments.length === 2, "the second comment");
  await r.comment("@review-bot can you look at x.ts?");
  await until(() => r.api.comments.length === 3, "the third comment");
  await sleep(200);
  assert.equal(r.prompts.length, 3, "a retried delivery is handled once");
  assert.equal(r.prompts[2].agent, r.prompts[0].agent);
  assert.match(r.prompts[2].text, /@ada commented on pull request acme\/widgets#12 \(Add widgets\):/);
  const conversations = (await r.db.query("select conversation from channel_conversations")).rows.map(row => row.conversation);
  assert.deepEqual(conversations, ["9-77-12"]);
});

test("filters: the app's own activity, drafts, unmentioned comments, other repos, events not chosen and strangers start nothing", async t => {
  const r = await setup(t, { repos: ["acme/widgets"] });
  await r.pullRequest("opened", {}, { sender: { id: 5, login: "review-bot[bot]", type: "Bot" } });
  await r.comment("@review-bot again", { sender: { id: 5, login: "review-bot[bot]", type: "Bot" } });
  await r.pullRequest("opened", { draft: true });
  await r.comment("just talking among ourselves");
  await r.comment("cc @review-bottle");
  await r.pullRequest("opened", {}, { repository: { id: 78, full_name: "acme/gadgets" } });
  await r.pullRequest("closed");
  await r.pullRequest("opened", {}, { sender: { id: 6, login: "eve", type: "User" } });
  await sleep(300);
  assert.equal(r.prompts.length, 0);
  // A draft marked ready does start one.
  await r.pullRequest("ready_for_review");
  await until(() => r.prompts.length === 1, "the ready-for-review turn");
});

test("with authors: members, a repository member needs no allowlist entry; contributors still do", async t => {
  const r = await setup(t, { authors: "members" });
  await r.comment("@review-bot hi", { sender: { id: 7, login: "grace", type: "User" }, comment: { body: "@review-bot hi", author_association: "MEMBER" } });
  await until(() => r.prompts.length === 1, "the member's turn");
  await r.comment("@review-bot hi", { sender: { id: 8, login: "mallory", type: "User" }, comment: { body: "@review-bot hi", author_association: "CONTRIBUTOR" } });
  await sleep(200);
  assert.equal(r.prompts.length, 1);
});

test("pushes in quick succession start one turn, on the latest", async t => {
  const r = await setup(t);
  await r.pullRequest("synchronize", { head: { ref: "widgets", sha: "1111111111111111" } }, { before: "0000", after: "1111111111111111" });
  await r.pullRequest("synchronize", { head: { ref: "widgets", sha: "2222222222222222" } }, { before: "1111", after: "2222222222222222" });
  await sleep(200);
  assert.equal(r.prompts.length, 0, "waiting out the debounce");
  await r.channels.scan(Date.now() + 60_000);
  await until(() => r.api.comments.length === 1, "the one comment");
  await sleep(200);
  assert.equal(r.prompts.length, 1);
  assert.match(r.prompts[0].text, /Head is now 222222222222/);
});

test("with reply: none the agent's reply is not posted", async t => {
  const r = await setup(t, { reply: "none" });
  await r.pullRequest("opened");
  await until(() => r.prompts.length === 1, "the turn");
  await until(async () => !(await r.db.query("select 1 from channel_items")).rowCount, "the item to finish");
  assert.equal(r.api.comments.length, 0);
});
