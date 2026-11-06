import type { IncomingMessage } from "node:http";
import { listen, type T } from "./http.ts";
import { requestBody } from "../channel-files.ts";

/**
 * Local stand-ins for the messaging services channels talk to, for the channel contract cases: the real
 * services are never called. Each backend is pointed at them by environment (AGENT_TELEGRAM_API_URL,
 * AGENT_SLACK_API_URL, AGENT_GITHUB_API_URL), as on ECS.
 */
export { requestBody };

export const BOT_TOKEN = "123456789:AAFixtureBotTokenSecretPart_abcdefXYZ";
export const ada = { id: 42, is_bot: false, first_name: "Ada", username: "ada" };
export const bob = { id: 7, is_bot: false, first_name: "Bob", username: "bob" };
export const from = (user: typeof ada, text: string, chat = user.id) => ({ from: user, chat: { id: chat, type: "private" }, text });

/** The text of the last user message a model request carries. */
export const lastUser = (body: any) => {
  const content = body.messages.filter((message: any) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join("\n");
};

async function read(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** A local stand-in for the Telegram Bot API; the real one is never called. */
export async function fakeTelegram(t: T) {
  const calls: { method: string; body: any }[] = [];
  /** Files bots may download, by file_id; getFile answers for others too, and their download is a 404. */
  const files = new Map<string, Buffer>();
  // `holdSends` keeps each sendMessage waiting until the test answers it with a status; `failFiles` fails that many file sends.
  const state = { failSends: 0, failFiles: 0, holdSends: false, held: [] as { body: any; release(status: number): void }[] };
  const url = await listen(t, async (req, res) => {
    const raw = await read(req);
    const file = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(req.url!);
    if (file) {
      const data = file[1] === BOT_TOKEN && files.get(file[2]!);
      if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(data);
      return;
    }
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url!);
    const answer = (status: number, value: object) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (!match || match[1] !== BOT_TOKEN) return answer(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = match[2]!;
    const body = await requestBody(req, raw);
    if ((method === "sendPhoto" || method === "sendDocument") && state.failFiles > 0) {
      state.failFiles--;
      calls.push({ method: `${method}:failed`, body });
      return answer(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    }
    if (method === "sendMessage" && state.holdSends) {
      const status = await new Promise<number>(release => state.held.push({ body, release }));
      if (status !== 200) {
        calls.push({ method: "sendMessage:failed", body });
        return answer(status, { ok: false, error_code: status, description: "Bad Request" });
      }
    }
    if (method === "sendMessage" && state.failSends > 0) {
      state.failSends--;
      calls.push({ method: "sendMessage:failed", body });
      return answer(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    }
    if (method === "sendPhoto" && body.photo.name.startsWith("wide")) {
      calls.push({ method: "sendPhoto:rejected", body });
      return answer(400, { ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" });
    }
    calls.push({ method, body });
    if (method === "getMe") return answer(200, { ok: true, result: { id: 123456789, is_bot: true, username: "fixture_bot" } });
    if (method === "getFile") return answer(200, { ok: true, result: { file_id: body.file_id, file_size: files.get(body.file_id)?.length, file_path: `files/${body.file_id}` } });
    return answer(200, { ok: true, result: true });
  });
  return {
    url, calls, files, state,
    sent: (chat?: string | number) => calls.filter(call => call.method === "sendMessage" && (chat === undefined || String(call.body.chat_id) === String(chat))).map(call => call.body.text as string),
    count: (method: string) => calls.filter(call => call.method === method).length,
    /** Files sent to a chat, in order: the method, name, caption and bytes. */
    sentFiles: (chat: string | number) => calls.filter(call => (call.method === "sendPhoto" || call.method === "sendDocument") && String(call.body.chat_id) === String(chat))
      .map(call => { const file = call.body.photo ?? call.body.document; return { method: call.method, name: file.name, caption: call.body.caption, data: file.data.toString() }; }),
  };
}
export type FakeTelegram = Awaited<ReturnType<typeof fakeTelegram>>;

/** A Telegram channel on a contract fixture: created through the API, its webhook secret as Telegram was given it. */
export function telegramChannels(r: { call(path: string, init?: any): Promise<{ status: number; json: any; text: string }>; base: string }, tg: FakeTelegram) {
  let update = 1000;
  const createChannel = async (fields: object = {}) => {
    const created = await r.call("/v1/channels", { body: { type: "telegram", credentials: { botToken: BOT_TOKEN }, ...fields } });
    if (created.status !== 201) throw new Error(`Channel creation failed: ${created.status} ${created.text}`);
    const secret = tg.calls.filter(entry => entry.method === "setWebhook").at(-1)!.body.secret_token as string;
    return { channel: created.json, secret };
  };
  /** Deliver a Telegram update to the channel's webhook, as Telegram would. */
  const deliver = (channel: { id: string }, secret: string | undefined, message: Record<string, unknown>, updateId = ++update) => fetch(`${r.base}/channels/telegram/${channel.id}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(secret !== undefined ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
    body: JSON.stringify({ update_id: updateId, message: { message_id: updateId, date: 0, ...message } }),
  }).then(response => response.status);
  return { createChannel, deliver };
}
