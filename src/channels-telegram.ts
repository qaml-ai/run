import { telegram as coreTelegram } from "./core/channels/telegram.ts";
import { network } from "./node-context.ts";

/** Telegram bots (src/core/channels/telegram.ts), through this node's outbound network. */
export function telegram(options: { apiUrl?: string } = {}) {
  return coreTelegram({ ...options, fetch: ((input: string, init?: RequestInit) => network().fetch(input, init)) as typeof fetch });
}
