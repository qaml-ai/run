import { slack as coreSlack } from "./core/channels/slack.ts";
import { network } from "./node-context.ts";

/** Slack apps (src/core/channels/slack.ts), through this node's outbound network. */
export function slack(options: { apiUrl?: string; maxFileBytes?: number } = {}) {
  return coreSlack({ ...options, fetch: ((input: string, init?: RequestInit) => network().fetch(input, init)) as typeof fetch });
}
