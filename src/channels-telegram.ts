import { timingSafeEqual } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import { SendError, type ChannelProvider, type Inbound } from "./channels.ts";

/** Photos above this are skipped: they travel inside the prompt request and the agent's journal. */
const MAX_IMAGE_BYTES = 750_000;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

/** Telegram bots through the Bot API. `apiUrl` is configurable so tests run against a fake. */
export function telegram(options: { apiUrl?: string } = {}): ChannelProvider {
  const base = (options.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const token = (credentials: Record<string, string>) => {
    const value = credentials.botToken;
    if (typeof value !== "string" || !/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/.test(value)) throw new HttpError(400, "Send credentials.botToken: the token BotFather gave you");
    return value;
  };
  // The token is part of the URL: errors name the method, never the URL.
  async function call(credentials: Record<string, string>, method: string, body: Record<string, unknown> = {}) {
    const response = await fetch(`${base}/bot${token(credentials)}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
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
      // Telegram sends each photo in several sizes, smallest first: take the largest that fits.
      const photo = Array.isArray(message.photo) ? message.photo.filter((size: any) => (size.file_size ?? 0) <= MAX_IMAGE_BYTES).at(-1) : undefined;
      if (!text && !photo) return undefined;
      const name = [message.from.first_name, message.from.last_name].filter(value => typeof value === "string").join(" ");
      return {
        conversationId: String(message.chat.id), messageId: `${message.chat.id}:${message.message_id}`,
        sender: { id: String(message.from.id), ...(message.from.username ? { username: String(message.from.username) } : {}), ...(name ? { name } : {}) },
        text, images: photo ? [String(photo.file_id)] : [],
        ...(/^\/start(@\w+)?(\s|$)/.test(text) ? { command: "start" as const } : {}),
      };
    },
    async images(credentials, references) {
      const images: ImageContent[] = [];
      for (const fileId of references) {
        const file = await call(credentials, "getFile", { file_id: fileId });
        if (!file?.file_path || (file.file_size ?? 0) > MAX_IMAGE_BYTES) continue;
        const response = await fetch(`${base}/file/bot${token(credentials)}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length > MAX_IMAGE_BYTES) continue;
        const extension = String(file.file_path).split(".").pop()!.toLowerCase();
        images.push({ type: "image", data: data.toString("base64"), mimeType: MIME[extension] ?? "image/jpeg" });
      }
      return images;
    },
    async send(credentials, conversationId, text) { await call(credentials, "sendMessage", { chat_id: conversationId, text }); },
    async typing(credentials, conversationId) { await call(credentials, "sendChatAction", { chat_id: conversationId, action: "typing" }); },
  };
}
