import { HttpError } from "../http-error.ts";
import { fetchWithoutRedirects } from "../no-redirect.ts";
import { fetchFile, SendError, type ChannelProvider, type Inbound } from "./channels.ts";
import { hmacSha256, sameText, toHex } from "./crypto.ts";

/** Slack takes files up to 1 GB; the runtime sends up to this (read into memory), and a link past it. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Slack's own limit for how old a signed request may be. */
const MAX_SKEW_S = 5 * 60;
/** Errors worth retrying; any other `ok: false` (channel_not_found, not_in_channel, invalid_auth…) will not change. */
const TRANSIENT = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/**
 * A conversation is a thread: `<channel>-<thread ts>`. A direct message is its own
 * conversation, `<channel>`, answered in place. With the setting `conversation: "channel"`
 * a Slack channel is one conversation (one agent) and each thread in it a part of it.
 */
const conversation = (channel: string, thread?: string) => thread ? `${channel}-${thread}` : channel;
const target = (conversationId: string) => {
  const [channel, thread] = conversationId.split("-", 2);
  return { channel, ...(thread ? { thread_ts: thread } : {}) };
};
const TS = /^\d{1,12}\.\d{1,9}$/;
/** Slack reads `&`, `<` and `>` as markup in message text. */
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Slack apps through the Events API. The tenant creates an app, installs it, and
 * gives its bot token and signing secret; Slack has no API to set an app's event
 * URL, so the tenant pastes the channel's `webhookUrl` into Event Subscriptions and
 * subscribes to `app_mention`, `message.im` and (for replies in threads without a
 * mention) `message.channels`. Attachments need the `files:read` scope and sending
 * files `files:write`. `apiUrl` is configurable so tests run against a fake; `fetch` is the host's outbound fetch.
 */
export function slack(options: { apiUrl?: string; fetch: typeof fetch; maxFileBytes?: number }): ChannelProvider {
  const base = (options.apiUrl ?? "https://slack.com/api").replace(/\/+$/, "");
  const token = (credentials: Record<string, string>) => {
    const value = credentials.botToken;
    if (typeof value !== "string" || !/^xoxb-[A-Za-z0-9-]{10,250}$/.test(value)) throw new HttpError(400, "Send credentials.botToken: the app's Bot User OAuth Token (xoxb-…)");
    return value;
  };
  const signingSecret = (credentials: Record<string, string>) => {
    const value = credentials.signingSecret;
    if (typeof value !== "string" || !/^[a-f0-9]{16,128}$/.test(value)) throw new HttpError(400, "Send credentials.signingSecret: the app's Signing Secret, from Basic Information");
    return value;
  };
  // Most methods take JSON; files.getUploadURLExternal takes only form fields.
  async function call(credentials: Record<string, string>, method: string, body: Record<string, unknown> | URLSearchParams = {}) {
    const form = body instanceof URLSearchParams;
    const response = await options.fetch(`${base}/${method}`, {
      method: "POST", headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8", Authorization: `Bearer ${token(credentials)}` },
      body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    }).catch(error => { throw new SendError(`Slack ${method} failed: ${error instanceof Error ? error.name : "network error"}`, false); });
    const answer = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; [key: string]: unknown };
    if (response.ok && answer.ok) return answer;
    const retryAfter = Number(response.headers.get("retry-after"));
    const error = answer.error ?? (response.status === 429 ? "ratelimited" : `HTTP ${response.status}`);
    const permanent = response.status < 500 && response.status !== 429 && !TRANSIENT.has(error);
    throw new SendError(`Slack ${method} failed: ${error}`, permanent, retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  return {
    label: "Slack",
    // Slack accepts more, but truncates past 40,000 and advises staying near 4,000.
    maxMessageLength: 4000,
    async setup(credentials) {
      const botToken = token(credentials);
      const secret = signingSecret(credentials);
      let me;
      try { me = await call(credentials, "auth.test"); }
      catch (error) { throw new HttpError(422, `Slack rejected the bot token (${error instanceof Error ? error.message : "auth.test failed"})`); }
      if (typeof me.user_id !== "string") throw new HttpError(422, "Slack auth.test did not name the bot user; use a bot token (xoxb-…)");
      return {
        account: {
          id: me.user_id, ...(typeof me.user === "string" ? { username: me.user } : {}),
          ...(typeof me.team_id === "string" ? { teamId: me.team_id } : {}), ...(typeof me.team === "string" ? { team: me.team } : {}),
        },
        masked: { botToken: `xoxb-…${botToken.slice(-4)}`, signingSecret: `…${secret.slice(-4)}` },
      };
    },
    // The event URL is the app's setting, not the token's; removing the channel makes it answer 404.
    async teardown() {},
    async verify(headers, body, _secret, credentials) {
      const timestamp = headers.get("x-slack-request-timestamp") ?? "";
      if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
      const expected = `v0=${toHex(await hmacSha256(signingSecret(credentials), `v0:${timestamp}:${body}`))}`;
      return sameText(headers.get("x-slack-signature") ?? "", expected);
    },
    settings(input, current) {
      const merged = { ...current, ...input };
      const unknown = Object.keys(merged).find(key => key !== "conversation");
      if (unknown) throw new HttpError(400, `Unknown Slack setting ${unknown}`);
      if (merged.conversation !== undefined && merged.conversation !== "thread" && merged.conversation !== "channel")
        throw new HttpError(400, 'settings.conversation is "thread" (default: one agent per thread) or "channel" (one agent per Slack channel, each thread part of its conversation)');
      return merged.conversation === "channel" ? { conversation: "channel" } : {};
    },
    // A thread of a channel conversation, or "new": the channel itself, where a message of the bot's own starts a thread.
    threadTarget(conversationId, thread) {
      const { channel } = target(conversationId);
      if (thread === "new") return channel;
      if (!TS.test(thread)) throw new Error('thread is a Slack thread from a message\'s from.thread (like 1730000000.123456), or "new"');
      return conversation(channel, thread);
    },
    handshake(payload: any) {
      return payload?.type === "url_verification" && typeof payload.challenge === "string" ? { challenge: payload.challenge } : undefined;
    },
    parse(payload: any, context?: { settings?: Record<string, unknown> }): Inbound | undefined {
      const event = payload?.event;
      if (payload?.type !== "event_callback" || !event || typeof event.channel !== "string" || typeof event.user !== "string" || typeof event.ts !== "string") return undefined;
      // Bots (this one included) and edits, deletions and joins are not messages to answer.
      if (event.bot_id || (event.subtype && event.subtype !== "file_share")) return undefined;
      let conversationId: string, continuation = false;
      const wholeChannel = context?.settings?.conversation === "channel" && event.channel_type !== "im";
      let thread: string | undefined;
      if (wholeChannel && (event.type === "app_mention" || (event.type === "message" && typeof event.thread_ts === "string" && event.thread_ts !== event.ts))) {
        // One conversation per Slack channel: the thread is where this message is, and where its reply goes.
        conversationId = conversation(event.channel);
        thread = event.thread_ts ?? event.ts;
        continuation = event.type === "message";
      } else if (event.type === "app_mention") conversationId = conversation(event.channel, event.thread_ts ?? event.ts);
      else if (event.type === "message" && event.channel_type === "im") conversationId = conversation(event.channel);
      // A reply in a thread the bot is already in, without a mention (that one comes as app_mention too).
      else if (event.type === "message" && typeof event.thread_ts === "string" && event.thread_ts !== event.ts) {
        conversationId = conversation(event.channel, event.thread_ts);
        continuation = true;
      } else return undefined;
      const text = (typeof event.text === "string" ? event.text : "").replace(/^\s*<@[A-Z0-9]+>\s*/, "").trim();
      // A file without a URL (hidden by the workspace's plan, or deleted) fails to download, and the agent is told.
      const files = (Array.isArray(event.files) ? event.files : []).filter((file: any) => file && typeof file === "object").map((file: any) => ({
        id: String(file.url_private_download ?? file.url_private ?? ""), name: typeof file.name === "string" ? file.name : "file",
        ...(typeof file.size === "number" ? { size: file.size } : {}), ...(typeof file.mimetype === "string" ? { contentType: file.mimetype } : {}),
      }));
      if (!text && !files.length) return undefined;
      return {
        conversationId,
        // Not the event id: a mention in a thread arrives as both app_mention and message, and must count once.
        messageId: `${event.channel}:${event.ts}`,
        sender: { id: event.user }, text, files,
        ...(continuation ? { continuation } : {}),
        ...(thread ? { thread, replyTo: conversation(event.channel, thread), threadKey: conversation(event.channel, thread) } : {}),
      };
    },
    async download(credentials, file) {
      // The bot token goes with the download: only ever to Slack's file host.
      if (!file.id.startsWith("https://files.slack.com/") && !file.id.startsWith(`${base}/`)) throw new Error("Not a Slack file URL");
      const download = await fetchFile(options.fetch, file.id, { Authorization: `Bearer ${token(credentials)}` });
      // Without files:read Slack answers with its sign-in page instead of the file.
      if (download.contentType === "text/html" && file.contentType !== "text/html") throw new Error("Slack answered with a sign-in page: does the app have files:read?");
      return download;
    },
    async send(credentials, conversationId, text) {
      await call(credentials, "chat.postMessage", { ...target(conversationId), text: escape(text), unfurl_links: false, unfurl_media: false });
    },
    maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
    // Slack's external upload: ask for an upload URL, post the bytes there, then share the file into the conversation.
    async sendFile(credentials, conversationId, file, caption) {
      const { upload_url, file_id } = await call(credentials, "files.getUploadURLExternal", new URLSearchParams({ filename: file.name, length: String(file.size) }));
      if (typeof upload_url !== "string" || !/^https?:\/\//.test(upload_url)) throw new SendError("Slack gave no upload URL", false);
      const uploaded = await fetchWithoutRedirects(options.fetch, upload_url, { method: "POST", body: await file.blob(), signal: AbortSignal.timeout(120_000) })
        .catch(error => { throw new SendError(`Slack file upload failed: ${error instanceof Error ? error.name : "network error"}`, false); });
      if (!uploaded.ok) throw new SendError(`Slack file upload failed: HTTP ${uploaded.status}`, false);
      const { channel, thread_ts } = target(conversationId);
      await call(credentials, "files.completeUploadExternal", {
        files: [{ id: file_id, title: file.name }], channel_id: channel, ...(thread_ts ? { thread_ts } : {}), ...(caption ? { initial_comment: caption } : {}),
      });
    },
    // Bots have no typing indicator in Slack.
  };
}
