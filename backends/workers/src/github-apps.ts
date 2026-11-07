import { GitHubApps, githubTokenCache, type GitHubAppAuth, type GitHubTokenCache } from "../../../src/core/github-apps.ts";
import { keyServices, type SecurityEnv } from "./security-services.ts";
import { withSql, type PostgresEnv } from "./postgres.ts";

export type GitHubAppsEnv = SecurityEnv & PostgresEnv & { AGENT_GITHUB_API_URL?: string };

/** Tokens this isolate holds, by database and API: kept across requests, as a Node process keeps its own. */
const caches = new Map<string, GitHubTokenCache>();

/**
 * A tenant's GitHub Apps on Workers (src/core/github-apps.ts): Postgres through Hyperdrive, the secrets key's sealing,
 * and the Worker's fetch to GitHub's API (AGENT_GITHUB_API_URL in tests, as the GitHub channel's).
 */
export async function workerGitHubApps(env: GitHubAppsEnv): Promise<GitHubApps> {
  const { accounts } = await keyServices(env);
  const apiUrl = env.AGENT_GITHUB_API_URL ?? "";
  const key = `${env.HYPERDRIVE.connectionString}|${apiUrl}`;
  let cache = caches.get(key);
  if (!cache) { if (caches.size > 16) caches.clear(); caches.set(key, cache = githubTokenCache()); }
  return new GitHubApps({
    sql: { query: (text, values) => withSql(env, sql => sql.query(text, values as unknown[])) as never },
    keys: { canStore: accounts.canStoreKeys, seal: (context, text) => accounts.seal(context, text), unseal: (context, sealed) => accounts.unseal(context, sealed) },
    fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as typeof fetch,
    ...(apiUrl ? { apiUrl } : {}),
    cache,
  });
}

/** A source (or egress grant) could not have its GitHub App token: unavailable for the call, saying why, never with a credential. */
export class GitHubAppTokenError extends Error {
  readonly code = "source_unavailable";
  readonly transient: boolean;
  readonly status?: number;
  constructor(message: string, transient: boolean, status?: number) { super(message); this.name = "GitHubAppTokenError"; this.transient = transient; if (status !== undefined) this.status = status; }
}

/** An Authorization header from a GitHub App's installation token, for a tool source; `refused` drops the last one sent. */
export function githubAppHeaders(env: GitHubAppsEnv, tenant: string, auth: GitHubAppAuth, label: string, destination: string) {
  let last: (() => void) | undefined;
  return {
    async headers(): Promise<Record<string, string>> {
      try {
        const minted = await (await workerGitHubApps(env)).token(tenant, auth, destination);
        last = minted.refused;
        return { Authorization: `Bearer ${minted.token}` };
      } catch (error) {
        const failure = error as { status?: number; transient?: boolean; message?: string };
        if (typeof failure?.status === "number") throw new GitHubAppTokenError(`${label}'s GitHub App token: ${failure.message}`, failure.transient === true);
        throw error;
      }
    },
    refused() { last?.(); },
  };
}
