import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import { SendError, type ChannelProvider, type Gateway, type GatewayHandlers, type Inbound } from "./channels.ts";

/** Images above this are skipped: they travel inside the prompt request and the agent's journal. */
const MAX_IMAGE_BYTES = 750_000;
/**
 * Guild messages and direct messages. Without the privileged MESSAGE_CONTENT intent
 * Discord still gives the text of DMs and of messages that mention the bot, which
 * are the only ones answered.
 */
const INTENTS = (1 << 9) | (1 << 12);
/** Close codes after which reconnecting cannot help: bad token, sharding, or intents not allowed. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes that end the session: reconnect with a fresh identify, not a resume. */
const SESSION_LOST = new Set([4007, 4009]);
/** Discord keeps a session resumable when the client closes with a code other than 1000 or 1001. */
const RECONNECT = 4000;
const MAX_BACKOFF_MS = 60_000;

/** A message the bot should answer: a DM, or one that mentions it. Exported for tests. */
export function parseMessage(message: any, botId: string): Inbound | undefined {
  if (!message?.author || message.author.bot || message.webhook_id || typeof message.channel_id !== "string" || typeof message.id !== "string") return undefined;
  // Default messages and replies; not joins, pins, or thread notices.
  if (message.type !== 0 && message.type !== 19) return undefined;
  const direct = !message.guild_id;
  const mentioned = Array.isArray(message.mentions) && message.mentions.some((user: any) => user?.id === botId);
  if (!direct && !mentioned) return undefined;
  const text = String(message.content ?? "").replaceAll(`<@${botId}>`, "").replaceAll(`<@!${botId}>`, "").trim();
  const images = (Array.isArray(message.attachments) ? message.attachments : [])
    .filter((file: any) => typeof file?.content_type === "string" && file.content_type.startsWith("image/") && typeof file.url === "string" && (file.size ?? 0) <= MAX_IMAGE_BYTES)
    .map((file: any) => String(file.url));
  if (!text && !images.length) return undefined;
  const author = message.author;
  return {
    // A DM, a channel, or a thread: each is a Discord channel, and each gets its own agent.
    conversationId: message.channel_id, messageId: message.id,
    sender: { id: String(author.id), ...(author.username ? { username: String(author.username) } : {}), ...(author.global_name ? { name: String(author.global_name) } : {}) },
    text, images,
  };
}

/**
 * Discord bots. Messages arrive over the Gateway, a WebSocket the channels core
 * keeps open on one node; replies go out through the REST API. The tenant creates
 * an application, adds a bot, invites it with Send Messages and Read Message
 * History, and gives its token. `apiUrl` is configurable so tests run against a fake.
 */
export function discord(options: { apiUrl?: string } = {}): ChannelProvider {
  const base = (options.apiUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
  const token = (credentials: Record<string, string>) => {
    const value = credentials.botToken;
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{50,100}$/.test(value)) throw new HttpError(400, "Send credentials.botToken: the bot's token, from the Developer Portal's Bot page");
    return value;
  };
  async function call(credentials: Record<string, string>, method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bot ${token(credentials)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    }).catch(error => { throw new SendError(`Discord ${method} ${path.split("/")[1]} failed: ${error instanceof Error ? error.name : "network error"}`, false); });
    if (response.status === 204) return {};
    const answer = await response.json().catch(() => ({})) as any;
    if (response.ok) return answer;
    const status = response.status;
    const retryAfter = Number(answer.retry_after ?? response.headers.get("retry-after"));
    throw new SendError(`Discord ${method} ${path.split("/")[1]} failed: HTTP ${status}${answer.message ? ` ${answer.message}` : ""}`,
      status >= 400 && status < 500 && status !== 429, retryAfter > 0 ? Math.ceil(retryAfter * 1000) : undefined);
  }

  function connect(credentials: Record<string, string>, handlers: GatewayHandlers): Gateway {
    let closed = false;
    let socket: WebSocket | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let sequence: number | null = null;
    let session: { id: string; url: string } | undefined;
    let botId = "";
    let failures = 0;
    const log = (type: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ type: `discord_gateway_${type}`, ...fields }));
    const send = (op: number, d: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d })); };

    async function open() {
      if (closed) return;
      let url = session?.url;
      if (!url) {
        try { url = String((await call(credentials, "GET", "/gateway/bot")).url); }
        catch (error) {
          if (error instanceof SendError && error.permanent) return fail(error);
          return reconnect();
        }
      }
      if (closed) return;
      let acked = true;
      const ws = socket = new WebSocket(`${url.replace(/\/+$/, "")}/?v=10&encoding=json`);
      ws.onmessage = event => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.s != null) sequence = payload.s;
        if (payload.op === 10) {
          // Hello: beat on Discord's interval, the first at a random point within it, and give up on a link whose beats go unanswered.
          const interval = Number(payload.d?.heartbeat_interval) || 41_250;
          const beat = () => {
            if (!acked) { log("zombie"); ws.close(RECONNECT); return; }
            acked = false;
            send(1, sequence);
            heartbeat = setTimeout(beat, interval);
          };
          clearTimeout(heartbeat);
          heartbeat = setTimeout(beat, interval * Math.random());
          if (session) send(6, { token: token(credentials), session_id: session.id, seq: sequence });
          else send(2, { token: token(credentials), intents: INTENTS, properties: { os: "linux", browser: "agent-runtime", device: "agent-runtime" } });
        } else if (payload.op === 11) acked = true;
        else if (payload.op === 1) send(1, sequence);
        else if (payload.op === 7) ws.close(RECONNECT);
        else if (payload.op === 9) {
          // Invalid session: resume if Discord says it can be, otherwise identify afresh.
          if (!payload.d) { session = undefined; sequence = null; }
          ws.close(RECONNECT);
        } else if (payload.op === 0) {
          if (payload.t === "READY") {
            botId = String(payload.d.user.id);
            session = { id: payload.d.session_id, url: payload.d.resume_gateway_url };
            failures = 0;
          } else if (payload.t === "RESUMED") failures = 0;
          else if (payload.t === "MESSAGE_CREATE" && botId) {
            const inbound = parseMessage(payload.d, botId);
            if (inbound) void handlers.message(inbound).catch(error => log("message_failed", { error: error instanceof Error ? error.message : String(error) }));
          }
        }
      };
      ws.onclose = event => {
        if (socket !== ws) return;
        clearTimeout(heartbeat);
        socket = undefined;
        if (closed) return;
        if (FATAL.has(event.code)) return fail(new Error(`Discord closed the gateway: ${event.code} ${event.reason || "fatal"}`));
        if (SESSION_LOST.has(event.code)) { session = undefined; sequence = null; }
        reconnect();
      };
      ws.onerror = () => {};
    }
    function reconnect() {
      if (closed) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures++) * (0.5 + Math.random() / 2);
      log("reconnect", { delayMs: Math.round(delay), resume: !!session });
      clearTimeout(retry);
      retry = setTimeout(() => void open(), delay);
    }
    function fail(error: Error) { close(); handlers.failed(error); }
    function close() {
      closed = true;
      clearTimeout(heartbeat);
      clearTimeout(retry);
      socket?.close(1000);
      socket = undefined;
    }
    void open();
    return { close };
  }

  return {
    label: "Discord",
    maxMessageLength: 2000,
    // Discord shows the indicator for ten seconds.
    typingMs: 8_000,
    async setup(credentials) {
      const botToken = token(credentials);
      let me;
      try { me = await call(credentials, "GET", "/users/@me"); }
      catch (error) { throw new HttpError(422, `Discord rejected the bot token (${error instanceof Error ? error.message : "users/@me failed"})`); }
      if (!me.bot) throw new HttpError(422, "That token is not a bot's; copy it from the Developer Portal's Bot page");
      return { account: { id: String(me.id), username: String(me.username) }, masked: { botToken: `…${botToken.slice(-4)}` } };
    },
    async teardown() {},
    connect,
    async images(_credentials, references) {
      const images: ImageContent[] = [];
      for (const url of references) {
        // Attachment links are signed and need no token; fetch only from Discord's CDN.
        if (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url) && !url.startsWith(`${base}/`)) continue;
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Discord attachment download failed: HTTP ${response.status}`);
        const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
        const data = Buffer.from(await response.arrayBuffer());
        if (!mimeType.startsWith("image/") || data.length > MAX_IMAGE_BYTES) continue;
        images.push({ type: "image", data: data.toString("base64"), mimeType });
      }
      return images;
    },
    async send(credentials, conversationId, content) {
      // The agent's text never pings @everyone, roles or users.
      await call(credentials, "POST", `/channels/${conversationId}/messages`, { content, allowed_mentions: { parse: [] } });
    },
    async typing(credentials, conversationId) { await call(credentials, "POST", `/channels/${conversationId}/typing`); },
  };
}
