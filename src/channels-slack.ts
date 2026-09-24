import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import { SendError, type ChannelProvider, type Inbound } from "./channels.ts";

/** Images above this are skipped: they travel inside the prompt request and the agent's journal. */
const MAX_IMAGE_BYTES = 750_000;
/** Slack's own limit for how old a signed request may be. */
const MAX_SKEW_S = 5 * 60;
/** Errors worth retrying; any other `ok: false` (channel_not_found, not_in_channel, invalid_auth…) will not change. */
const TRANSIENT = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/**
 * A conversation is a thread: `<channel>-<thread ts>`. A direct message is its own
 * conversation, `<channel>`, answered in place.
 */
const conversation = (channel: string, thread?: string) => thread ? `${channel}-${thread}` : channel;
const target = (conversationId: string) => {
  const [channel, thread] = conversationId.split("-", 2);
  return { channel, ...(thread ? { thread_ts: thread } : {}) };
};
/** Slack reads `&`, `<` and `>` as markup in message text. */
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Slack apps through the Events API. The tenant creates an app, installs it, and
 * gives its bot token and signing secret; Slack has no API to set an app's event
 * URL, so the tenant pastes the channel's `webhookUrl` into Event Subscriptions and
 * subscribes to `app_mention`, `message.im` and (for replies in threads without a
 * mention) `message.channels`. `apiUrl` is configurable so tests run against a fake.
 */
export function slack(options: { apiUrl?: string } = {}): ChannelProvider {
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
  async function call(credentials: Record<string, string>, method: string, body: Record<string, unknown> = {}) {
    const response = await fetch(`${base}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token(credentials)}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
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
    verify(headers, body, _secret, credentials) {
      const timestamp = headers.get("x-slack-request-timestamp") ?? "";
      if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_S) return false;
      const given = Buffer.from(headers.get("x-slack-signature") ?? "");
      const expected = Buffer.from(`v0=${createHmac("sha256", signingSecret(credentials)).update(`v0:${timestamp}:${body}`).digest("hex")}`);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
    handshake(payload: any) {
      return payload?.type === "url_verification" && typeof payload.challenge === "string" ? { challenge: payload.challenge } : undefined;
    },
    parse(payload: any): Inbound | undefined {
      const event = payload?.event;
      if (payload?.type !== "event_callback" || !event || typeof event.channel !== "string" || typeof event.user !== "string" || typeof event.ts !== "string") return undefined;
      // Bots (this one included) and edits, deletions and joins are not messages to answer.
      if (event.bot_id || (event.subtype && event.subtype !== "file_share")) return undefined;
      let conversationId: string, continuation = false;
      if (event.type === "app_mention") conversationId = conversation(event.channel, event.thread_ts ?? event.ts);
      else if (event.type === "message" && event.channel_type === "im") conversationId = conversation(event.channel);
      // A reply in a thread the bot is already in, without a mention (that one comes as app_mention too).
      else if (event.type === "message" && typeof event.thread_ts === "string" && event.thread_ts !== event.ts) {
        conversationId = conversation(event.channel, event.thread_ts);
        continuation = true;
      } else return undefined;
      const text = (typeof event.text === "string" ? event.text : "").replace(/^\s*<@[A-Z0-9]+>\s*/, "").trim();
      const images = (Array.isArray(event.files) ? event.files : [])
        .filter((file: any) => typeof file?.mimetype === "string" && file.mimetype.startsWith("image/") && typeof file.url_private === "string" && (file.size ?? 0) <= MAX_IMAGE_BYTES)
        .map((file: any) => String(file.url_private));
      if (!text && !images.length) return undefined;
      return {
        conversationId,
        // Not the event id: a mention in a thread arrives as both app_mention and message, and must count once.
        messageId: `${event.channel}:${event.ts}`,
        sender: { id: event.user }, text, images,
        ...(continuation ? { continuation } : {}),
      };
    },
    async images(credentials, references) {
      const images: ImageContent[] = [];
      for (const url of references) {
        // The bot token goes with the download: only ever to Slack's file host.
        if (!url.startsWith("https://files.slack.com/") && !url.startsWith(`${base}/`)) continue;
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token(credentials)}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Slack file download failed: HTTP ${response.status}`);
        const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
        const data = Buffer.from(await response.arrayBuffer());
        // Without files:read Slack answers with its sign-in page instead of the file.
        if (!mimeType.startsWith("image/") || data.length > MAX_IMAGE_BYTES) continue;
        images.push({ type: "image", data: data.toString("base64"), mimeType });
      }
      return images;
    },
    async send(credentials, conversationId, text) {
      await call(credentials, "chat.postMessage", { ...target(conversationId), text: escape(text), unfurl_links: false, unfurl_media: false });
    },
    // Bots have no typing indicator in Slack.
  };
}
