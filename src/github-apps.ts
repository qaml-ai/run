import type { Accounts } from "./accounts.ts";
import type { Db } from "./db.ts";
import { network } from "./node-context.ts";
import { GitHubApps } from "./core/github-apps.ts";

export { GitHubApps, GitHubAppError, githubAppAuthInput, GITHUB_HOSTS, type GitHubAppAuth } from "./core/github-apps.ts";

/**
 * A tenant's GitHub Apps on the Node runtime (src/core/github-apps.ts): Postgres, AGENT_SECRETS_KEY's sealing, and
 * this node's outbound network to GitHub's API. One per process, so a minted token is reused by every agent it fits.
 */
export function nodeGitHubApps(options: { db: Db; accounts: Accounts; apiUrl?: string }) {
  const { accounts } = options;
  return new GitHubApps({
    sql: options.db,
    keys: { get canStore() { return accounts.canStoreKeys; }, seal: (context, text) => accounts.seal(context, text), unseal: (context, sealed) => accounts.unseal(context, sealed) },
    fetch: ((input: string, init?: RequestInit) => network().fetch(input, init)) as typeof fetch,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
  });
}
