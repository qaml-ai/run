import { github as coreGithub } from "./core/channels/github.ts";
import { network } from "./node-context.ts";

export { GITHUB_EVENTS, type GitHubSettings } from "./core/channels/github.ts";

/** GitHub Apps (src/core/channels/github.ts), through this node's outbound network. */
export function github(options: { apiUrl?: string } = {}) {
  return coreGithub({ ...options, fetch: ((input: string, init?: RequestInit) => network().fetch(input, init)) as typeof fetch });
}
