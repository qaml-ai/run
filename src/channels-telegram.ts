import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.ts";
import { fetchFile, SendError, type ChannelProvider, type Inbound, type InboundFile } from "./channels.ts";
import { network } from "./node-context.ts";

/** Bot API limits: bots download files up to 20 MB, and send photos up to 10 MB and other files up to 50 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1000 * 1000;
const MAX_PHOTO_BYTES = 10 * 1000 * 1000;
const MAX_FILE_BYTES = 50 * 1000 * 1000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Attachments besides photos, each one file with its own `file_id` (an animation repeats itself as `document`). */
const KINDS = ["document", "audio", "voice", "video", "animation"];

/** Telegram bots through the Bot API. `apiUrl` is configurable so tests run against a fake. */
export function telegram(options: { apiUrl?: string } = {}): ChannelProvider {
  const base = (options.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const token = (credentials: Record<string, string>) => {
    const value = credentials.botToken;
    if (typeof value !== "string" || !/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/.test(value)) throw new HttpError(400, "Send credentials.botToken: the token BotFather gave you");
    return value;
  };
  // The token is part of the URL: errors name the method, never the URL.
  async function call(credentials: Record<string, string>, method: string, body: Record<string, unknown> | FormData = {}) {
    const form = body instanceof FormData;
    const response = await network().fetch(`${base}/bot${token(credentials)}/${method}`, {
      method: "POST", ...(form ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(form ? 120_000 : 15_000),
    }).catch(error => { throw new SendError(`Telegram ${method} failed: ${error instanceof Error ? error.name : "network error"}`, false); });
    const answer = await response.json().catch(() => ({})) as { ok?: boolean; result?: any; description?: string; parameters?: { retry_after?: number } };
    if (answer.ok) return answer.result;
    const status = response.status;
    const retryAfter = answer.parameters?.retry_after;
    throw new SendError(`Telegram ${method} failed: HTTP ${status}${answer.description ? ` ${answer.description}` : ""}`,
      status >= 400 && status < 500 && status !== 429, retryAfter ? retryAfter * 1000 : undefined);
  }
  return {
    label: "Telegram",
    maxMessageLength: 4096,
    async setup(credentials, webhook) {
      const botToken = token(credentials);
      let me;
      try { me = await call(credentials, "getMe"); }
      catch (error) { throw new HttpError(422, `Telegram rejected the bot token (${error instanceof Error ? error.message : "getMe failed"})`); }
      try { await call(credentials, "setWebhook", { url: webhook.url, secret_token: webhook.secret, allowed_updates: ["message"] }); }
      catch (error) { throw new HttpError(422, error instanceof Error ? error.message : "setWebhook failed"); }
      return {
        account: { id: String(me.id), ...(me.username ? { username: String(me.username) } : {}) },
        masked: { botToken: `${botToken.slice(0, botToken.indexOf(":") + 1)}…${botToken.slice(-4)}` },
      };
    },
    async teardown(credentials) { await call(credentials, "deleteWebhook"); },
    verify(headers, _body, secret) {
      const given = Buffer.from(headers.get("x-telegram-bot-api-secret-token") ?? "");
      const expected = Buffer.from(secret);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
    parse(update: any): Inbound | undefined {
      const message = update?.message;
      if (!message?.chat || !message.from || message.from.is_bot || typeof update.update_id !== "number") return undefined;
      const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
      const files: InboundFile[] = [];
      const add = (file: any, name: string, contentType?: string) => {
        if (typeof file?.file_id !== "string" || files.some(entry => entry.id === file.file_id)) return;
        files.push({ id: file.file_id, name, ...(typeof file.file_size === "number" ? { size: file.file_size } : {}), ...(contentType ? { contentType } : {}) });
      };
      // Telegram sends each photo in several sizes, smallest first: take the largest.
      if (Array.isArray(message.photo)) add(message.photo.at(-1), "photo.jpg", "image/jpeg");
      for (const kind of KINDS) {
        const file = message[kind], type = typeof file?.mime_type === "string" ? file.mime_type : undefined;
        add(file, typeof file?.file_name === "string" ? file.file_name : `${kind}${type ? `.${type.split("/")[1]}` : ""}`, type);
      }
      if (!text && !files.length) return undefined;
      const name = [message.from.first_name, message.from.last_name].filter(value => typeof value === "string").join(" ");
      return {
        conversationId: String(message.chat.id), messageId: `${message.chat.id}:${message.message_id}`,
        sender: { id: String(message.from.id), ...(message.from.username ? { username: String(message.from.username) } : {}), ...(name ? { name } : {}) },
        text, files,
        ...(/^\/start(@\w+)?(\s|$)/.test(text) ? { command: "start" as const } : {}),
      };
    },
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    async download(credentials, file) {
      const found = await call(credentials, "getFile", { file_id: file.id });
      if (typeof found?.file_path !== "string") throw new Error("Telegram getFile gave no path");
      return fetchFile(`${base}/file/bot${token(credentials)}/${found.file_path}`);
    },
    async send(credentials, conversationId, text) { await call(credentials, "sendMessage", { chat_id: conversationId, text }); },
    maxFileBytes: MAX_FILE_BYTES,
    // Images Telegram can show go as photos (a photo it will not take, by its dimensions, goes as a document); the rest as documents.
    async sendFile(credentials, conversationId, file, caption) {
      const data = await file.blob();
      const as = async (method: "sendPhoto" | "sendDocument") => {
        const form = new FormData();
        form.set("chat_id", conversationId);
        if (caption) form.set("caption", caption.slice(0, 1024));
        form.set(method === "sendPhoto" ? "photo" : "document", data, file.name);
        await call(credentials, method, form);
      };
      if (!PHOTO_TYPES.includes(file.contentType) || file.size > MAX_PHOTO_BYTES) return as("sendDocument");
      await as("sendPhoto").catch(error => { if (error instanceof SendError && error.permanent) return as("sendDocument"); throw error; });
    },
    async typing(credentials, conversationId) { await call(credentials, "sendChatAction", { chat_id: conversationId, action: "typing" }); },
  };
}
