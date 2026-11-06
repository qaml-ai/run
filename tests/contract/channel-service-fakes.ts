import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { listen, type T } from "./http.ts";
import { requestBody } from "../channel-files.ts";

/**
 * Local stand-ins for Slack's Web API and GitHub's REST API, for the channel contract cases: the real services are
 * never called. Each backend is pointed at them by environment (AGENT_SLACK_API_URL, AGENT_GITHUB_API_URL), as on ECS.
 */

type Call = (path: string, init?: any) => Promise<{ status: number; json: any; text: string }>;

export const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * What a channel agent's model was asked: who the runtime says is talking, the words, and the blocks after them (a line and
 * the content for each file). The runtime's context block comes first, in the same text block as the words or apart from them.
 */
export function asked(body: any) {
  const user = body.messages.filter((message: any) => message.role === "user").at(-1);
  const blocks: any[] = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content;
  const found = /^<<<RUNTIME_CONTEXT>>>\n(.*)\n<<<END_RUNTIME_CONTEXT>>>(?:\n([\s\S]*))?$/.exec(blocks[0].text);
  if (!found) return { from: undefined, text: blocks[0].text as string, rest: blocks.slice(1) };
  const joined = found[2] !== undefined;
  return { from: JSON.parse(found[1]!).from, text: (joined ? found[2] : blocks[1]?.text ?? "") as string, rest: blocks.slice(joined ? 1 : 2) };
}

/** The files an agent's workspace holds under /uploads/<request id>, by name, read through the volume API. */
export async function uploaded(call: Call, base: string, token: string, agent: string, request: string) {
  const mounts = (await call(`/v1/agents/${agent}/mounts`)).json as { volumeId: string }[];
  const volume = mounts[0]!.volumeId;
  const listed = (await call(`/v1/volumes/${volume}/files?prefix=/uploads/${request}`)).json.files as { path: string; contentType: string }[];
  const read = async (path: string) => Buffer.from(await (await fetch(`${base}/v1/volumes/${volume}/files${path}`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
  return { listed, read };
}

// ---- Slack -----------------------------------------------------------------------------------------------------

export const SLACK_BOT_TOKEN = "xoxb-1111-2222-FixtureSlackBotToken";
export const SLACK_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";

/** A local stand-in for Slack's Web API and file host; the real one is never called. */
export async function fakeSlack(t: T) {
  const calls: { method: string; body: any }[] = [];
  const downloads: string[] = [];
  /** Files on the fake file host, by path; anything else there is a 404. */
  const hosted = new Map<string, { data: Buffer; type: string }>();
  const uploads = new Map<string, Buffer>();
  const url: string = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const answer = (value: object, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.url!.startsWith("/files/")) {
      downloads.push(req.headers.authorization ?? "");
      if (req.headers.authorization !== `Bearer ${SLACK_BOT_TOKEN}`) { res.writeHead(200, { "Content-Type": "text/html" }).end("<html>sign in</html>"); return; }
      const file = hosted.get(req.url!);
      if (!file) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": file.type }).end(file.data);
      return;
    }
    // The upload URL takes the bytes without the token.
    if (req.url!.startsWith("/upload/")) { uploads.set(req.url!.slice("/upload/".length), raw); res.writeHead(200).end("OK"); return; }
    if (req.headers.authorization !== `Bearer ${SLACK_BOT_TOKEN}`) return answer({ ok: false, error: "invalid_auth" });
    const method = req.url!.slice(1);
    const body = await requestBody(req, raw);
    calls.push({ method, body });
    if (method === "auth.test") return answer({ ok: true, user_id: "UBOT", user: "fixture_bot", team_id: "T1", team: "Fixture" });
    if (method === "files.getUploadURLExternal") {
      if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return answer({ ok: false, error: "invalid_arguments" });
      const id = `F${calls.length}`;
      return answer({ ok: true, upload_url: `${url}/upload/${id}`, file_id: id });
    }
    if (method === "chat.postMessage" && body.channel === "CGONE") return answer({ ok: false, error: "channel_not_found" });
    return answer({ ok: true });
  });
  return {
    url, calls, downloads, hosted, uploads,
    posts: () => calls.filter(call => call.method === "chat.postMessage").map(call => call.body),
  };
}
export type FakeSlack = Awaited<ReturnType<typeof fakeSlack>>;

/** A Slack channel on a contract fixture: created through the API, deliveries signed as Slack signs them. */
export function slackChannels(r: { call: Call; base: string }) {
  const createChannel = async (fields: object = {}) => {
    const created = await r.call("/v1/channels", { body: { type: "slack", credentials: { botToken: SLACK_BOT_TOKEN, signingSecret: SLACK_SIGNING_SECRET }, access: { allow: ["U_ADA"] }, ...fields } });
    if (created.status !== 201) throw new Error(`Channel creation failed: ${created.status} ${created.text}`);
    return created.json;
  };
  /** Deliver a payload as Slack would: signed with the signing secret over the timestamp and raw body. */
  const post = (channel: { id: string }, payload: object, options: { secret?: string; timestamp?: number } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", options.secret ?? SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return fetch(`${r.base}/channels/slack/${channel.id}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature }, body,
    });
  };
  const event = (channel: { id: string }, fields: Record<string, unknown>) => post(channel, { type: "event_callback", event_id: `Ev${randomBytes(4).toString("hex")}`, event: { user: "U_ADA", ...fields } });
  return { createChannel, post, event };
}

// ---- GitHub ----------------------------------------------------------------------------------------------------

export const GITHUB_WEBHOOK_SECRET = "fixture-webhook-secret";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** The app's key as GitHub issues it: PKCS#1. */
export const GITHUB_PEM = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
export const DIFF = "diff --git a/x.ts b/x.ts\n+hello\n";

/** A local stand-in for GitHub's REST API; the real one is never called. */
export async function fakeGitHub(t: T) {
  const comments: { path: string; body: string }[] = [];
  const tokensIssued: string[] = [];
  const diffs: string[] = [];
  const url = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const answer = (value: object, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const auth = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (req.url === "/app" || req.url!.startsWith("/app/")) {
      // The app's JWT, signed with its private key.
      const [header, payload, signature] = auth.split(".");
      if (!signature || !verify("sha256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"))) return answer({ message: "Bad credentials" }, 401);
      if (JSON.parse(Buffer.from(payload!, "base64url").toString()).iss !== "4242") return answer({ message: "Bad credentials" }, 401);
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
  return { url, comments, tokensIssued, diffs };
}
export type FakeGitHub = Awaited<ReturnType<typeof fakeGitHub>>;

/** A GitHub channel on a contract fixture: created through the API, deliveries signed as GitHub signs them. */
export function githubChannels(r: { call: Call; base: string }) {
  const createChannel = async (fields: object = {}) => {
    const created = await r.call("/v1/channels", { body: {
      type: "github", credentials: { appId: "4242", privateKey: GITHUB_PEM, webhookSecret: GITHUB_WEBHOOK_SECRET }, access: { allow: ["ada"] }, ...fields } });
    if (created.status !== 201) throw new Error(`Channel creation failed: ${created.status} ${created.text}`);
    return created.json;
  };
  /** Deliver an event as GitHub would: signed over the raw body, with its type and delivery id in headers. */
  const post = (channel: { id: string }, event: string, payload: object, options: { secret?: string; delivery?: string } = {}) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", options.secret ?? GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
    return fetch(`${r.base}/channels/github/${channel.id}`, {
      method: "POST", body,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": options.delivery ?? randomUUID(), "X-Hub-Signature-256": signature },
    });
  };
  const common = { installation: { id: 9 }, repository: { id: 77, full_name: "acme/widgets" }, sender: { id: 1, login: "ada", type: "User" } };
  const pull = (fields: Record<string, unknown> = {}) => ({
    number: 12, title: "Add widgets", body: "Adds the widget.", html_url: "https://github.com/acme/widgets/pull/12", draft: false,
    user: { login: "ada" }, author_association: "CONTRIBUTOR", base: { ref: "main" }, head: { ref: "widgets", sha: "abcdef1234567890" }, ...fields,
  });
  const pullRequest = (channel: { id: string }, action: string, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    post(channel, "pull_request", { action, pull_request: pull(fields), ...common, ...extra });
  const comment = (channel: { id: string }, body: string, extra: Record<string, unknown> = {}) => post(channel, "issue_comment", {
    action: "created", issue: { number: 12, title: "Add widgets", pull_request: {} },
    comment: { body, html_url: "https://github.com/acme/widgets/pull/12#issuecomment-1", author_association: "CONTRIBUTOR" }, ...common, ...extra,
  });
  return { createChannel, post, pull, pullRequest, comment, common };
}
