import { createHmac, createPrivateKey, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { HttpError } from "./http.ts";
import { fetchFile, SendError, type ChannelProvider, type ChannelSettings, type Inbound, type InboundFile, type ParseContext } from "./channels.ts";
import { network } from "./node-context.ts";

/** What can start a turn: pull request activity, and comments that @mention the app. */
export const GITHUB_EVENTS = [
  "pull_request.opened", "pull_request.reopened", "pull_request.ready_for_review", "pull_request.synchronize",
  "issue_comment", "pull_request_review_comment", "issues.opened",
] as const;
const DEFAULT_EVENTS = GITHUB_EVENTS.filter(event => event !== "issues.opened");
/** Who may start a turn besides the allowlist: `members` lets in a repository's owners, members and collaborators. */
const MEMBERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MAX_BODY_TEXT = 4_000;
const DEFAULT_DEBOUNCE_SECONDS = 30;
/** An installation token lasts an hour; one this close to expiry is replaced. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface GitHubSettings {
  events: string[];
  /** `owner/repo` or `owner/*`, any case; empty for every repository the app is installed on. */
  repos: string[];
  ignoreDrafts: boolean;
  /** `comment` posts each turn's reply on the pull request or issue; `none` leaves the agent to act through its tools. */
  reply: "comment" | "none";
  authors: "allowlist" | "members";
  /** How long new commits wait for more before a turn starts on them. */
  debounceSeconds: number;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const truncate = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * GitHub through a GitHub App. The tenant creates an app, installs it on repositories, and gives its
 * app id, private key and webhook secret; GitHub has no API to set an app's webhook URL, so the tenant
 * pastes the channel's `webhookUrl` into the app. A pull request or issue is a conversation
 * (`<installation>-<repository id>-<number>`), its agent made on the first event that starts a turn;
 * replies are comments on it. `apiUrl` is configurable so tests run against a fake.
 */
export function github(options: { apiUrl?: string } = {}): ChannelProvider {
  const base = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const tokens = new Map<string, { token: string; expires: number }>();
  const names = new Map<string, string>();
  const keys = new Map<string, KeyObject>();

  const appId = (credentials: Record<string, string>) => {
    const value = credentials.appId;
    if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new HttpError(400, "Send credentials.appId: the App ID from the app's General settings");
    return value;
  };
  const key = (credentials: Record<string, string>) => {
    const pem = credentials.privateKey;
    let value = typeof pem === "string" ? keys.get(pem) : undefined;
    if (value) return value;
    try { value = createPrivateKey(pem); } catch { throw new HttpError(400, "Send credentials.privateKey: a private key generated for the app (PEM)"); }
    if (value.asymmetricKeyType !== "rsa") throw new HttpError(400, "credentials.privateKey must be the app's RSA key");
    if (keys.size > 100) keys.clear();
    keys.set(pem, value);
    return value;
  };
  const webhookSecret = (credentials: Record<string, string>) => {
    const value = credentials.webhookSecret;
    if (typeof value !== "string" || !value) throw new HttpError(400, "Send credentials.webhookSecret: the app's webhook secret");
    return value;
  };
  /** A JWT the app signs for itself, good for ten minutes (backdated a minute for clock drift). */
  const jwt = (credentials: Record<string, string>) => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId(credentials) }))}`;
    return `${unsigned}.${base64url(sign("sha256", Buffer.from(unsigned), key(credentials)))}`;
  };
  const headers = (auth: string, accept = "application/vnd.github+json") => ({
    Accept: accept, Authorization: `Bearer ${auth}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "camelai-agent-runtime",
  });

  async function call(auth: string, method: string, path: string, body?: unknown) {
    const response = await network().fetch(`${base}${path}`, {
      method, headers: { ...headers(auth), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    }).catch(error => { throw new SendError(`GitHub ${method} ${path.split("/").slice(0, 3).join("/")} failed: ${error instanceof Error ? error.name : "network error"}`, false); });
    const answer = await response.json().catch(() => ({})) as Record<string, any>;
    if (response.ok) return answer;
    const status = response.status;
    const retryAfter = Number(response.headers.get("retry-after"));
    // A rate limit comes as 403 or 429, with retry-after or an exhausted quota; other 4xx will not change.
    const limited = status === 429 || (status === 403 && (retryAfter > 0 || response.headers.get("x-ratelimit-remaining") === "0"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const wait = retryAfter > 0 ? retryAfter * 1000 : limited && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined;
    throw new SendError(`GitHub ${method} ${path} failed: HTTP ${status}${typeof answer.message === "string" ? ` ${answer.message}` : ""}`,
      !limited && status >= 400 && status < 500, wait);
  }

  /** An installation token, reused until shortly before it expires. */
  async function installationToken(credentials: Record<string, string>, installation: string) {
    const cacheKey = `${appId(credentials)}:${installation}`;
    const cached = tokens.get(cacheKey);
    if (cached && cached.expires - TOKEN_MARGIN_MS > Date.now()) return cached.token;
    const answer = await call(jwt(credentials), "POST", `/app/installations/${installation}/access_tokens`);
    if (typeof answer.token !== "string") throw new SendError("GitHub gave no installation token", false);
    if (tokens.size > 1000) tokens.clear();
    tokens.set(cacheKey, { token: answer.token, expires: Date.parse(answer.expires_at) || Date.now() + 60 * 60_000 });
    return answer.token as string;
  }

  /** A repository's `owner/name` by its id, which survives renames; conversations are keyed by the id. */
  async function repository(token: string, id: string) {
    const known = names.get(id);
    if (known) return known;
    const answer = await call(token, "GET", `/repositories/${id}`);
    if (typeof answer.full_name !== "string") throw new SendError(`GitHub repository ${id} has no name`, true);
    if (names.size > 10_000) names.clear();
    names.set(id, answer.full_name);
    return answer.full_name as string;
  }

  const target = (conversationId: string) => {
    const [installation, repo, number] = conversationId.split("-");
    if (!/^\d+$/.test(installation ?? "") || !/^\d+$/.test(repo ?? "") || !/^\d+$/.test(number ?? "")) throw new SendError(`Not a GitHub conversation: ${conversationId}`, true);
    return { installation, repo, number };
  };

  return {
    label: "GitHub",
    maxMessageLength: 65_536,
    // Comments carry no files: the core sends a link instead.
    maxFileBytes: 0,
    maxBodyBytes: 5 * 1024 * 1024,
    async setup(credentials) {
      webhookSecret(credentials);
      let app;
      try { app = await call(jwt(credentials), "GET", "/app"); }
      catch (error) { throw new HttpError(422, `GitHub rejected the app credentials (${error instanceof Error ? error.message : "GET /app failed"})`); }
      if (typeof app.slug !== "string") throw new HttpError(422, "GitHub did not name the app");
      const pem = credentials.privateKey;
      return {
        account: { id: String(app.id), slug: app.slug, username: app.slug, botLogin: `${app.slug}[bot]`, ...(typeof app.name === "string" ? { name: app.name } : {}) },
        masked: { appId: appId(credentials), privateKey: `…${pem.trim().slice(-40, -30)}…`, webhookSecret: `…${credentials.webhookSecret.slice(-4)}` },
      };
    },
    // The webhook URL is the app's setting; removing the channel makes it answer 404.
    async teardown() {},
    settings(input, current) {
      const merged = { ...current, ...input } as ChannelSettings;
      const known = new Set(["events", "repos", "ignoreDrafts", "reply", "authors", "debounceSeconds"]);
      const unknown = Object.keys(input ?? {}).find(name => !known.has(name));
      if (unknown) throw new HttpError(400, `Unknown GitHub setting ${unknown}; settings are ${[...known].join(", ")}`);
      const events = merged.events ?? DEFAULT_EVENTS;
      if (!Array.isArray(events) || !events.every(event => (GITHUB_EVENTS as readonly unknown[]).includes(event))) throw new HttpError(400, `settings.events: some of ${GITHUB_EVENTS.join(", ")}`);
      const repos = merged.repos ?? [];
      if (!Array.isArray(repos) || !repos.every(repo => typeof repo === "string" && /^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)$/.test(repo))) throw new HttpError(400, "settings.repos: owner/repo or owner/* entries");
      const ignoreDrafts = merged.ignoreDrafts ?? true;
      if (typeof ignoreDrafts !== "boolean") throw new HttpError(400, "settings.ignoreDrafts is true or false");
      const reply = merged.reply ?? "comment";
      if (reply !== "comment" && reply !== "none") throw new HttpError(400, "settings.reply is comment or none");
      const authors = merged.authors ?? "allowlist";
      if (authors !== "allowlist" && authors !== "members") throw new HttpError(400, "settings.authors is allowlist or members");
      const debounceSeconds = merged.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS;
      if (typeof debounceSeconds !== "number" || !Number.isInteger(debounceSeconds) || debounceSeconds < 0 || debounceSeconds > 600) throw new HttpError(400, "settings.debounceSeconds: 0 to 600");
      return { events: [...new Set(events)], repos, ignoreDrafts, reply, authors, debounceSeconds } satisfies GitHubSettings;
    },
    replies: settings => settings.reply !== "none",
    verify(headers, body, _secret, credentials) {
      const given = Buffer.from(headers.get("x-hub-signature-256") ?? "");
      const expected = Buffer.from(`sha256=${createHmac("sha256", webhookSecret(credentials)).update(body).digest("hex")}`);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
    // Sent when the app's webhook is set up or tested.
    handshake(payload: any) { return typeof payload?.zen === "string" && payload.hook_id !== undefined ? {} : undefined; },
    parse(payload: any, context: ParseContext): Inbound | undefined {
      return parseEvent(payload, context);
    },
    async download(credentials, file) {
      const [installation, repo, number] = file.id.split(":");
      if (!/^\d+$/.test(installation ?? "") || !/^\d+$/.test(repo ?? "") || !/^\d+$/.test(number ?? "")) throw new Error("Not a GitHub diff");
      const token = await installationToken(credentials, installation);
      const name = await repository(token, repo);
      // The token goes only to the API host; fetchFile refuses redirects.
      return fetchFile(`${base}/repos/${name}/pulls/${number}`, headers(token, "application/vnd.github.diff"));
    },
    async send(credentials, conversationId, text) {
      const { installation, repo, number } = target(conversationId);
      const token = await installationToken(credentials, installation);
      await call(token, "POST", `/repos/${await repository(token, repo)}/issues/${number}/comments`, { body: text });
    },
    async sendFile() { throw new SendError("GitHub comments cannot carry files", true); },
    // GitHub has no typing indicator.
  };
}

/** A webhook delivery as a message, when it is one the channel's settings start a turn on. */
function parseEvent(payload: any, { headers, account, settings: stored }: ParseContext): Inbound | undefined {
  const event = headers.get("x-github-event") ?? "";
  const delivery = headers.get("x-github-delivery") ?? "";
  const settings = stored as Partial<GitHubSettings>;
  const events = settings.events ?? DEFAULT_EVENTS;
  const sender = payload?.sender, repo = payload?.repository, installation = payload?.installation?.id;
  if (!delivery || !sender || typeof sender.login !== "string" || !repo || typeof repo.full_name !== "string" || typeof installation !== "number") return undefined;
  // What the app did itself (its comments, its pushes) never starts a turn: no loops.
  if (sender.type === "Bot" || sender.login === account.botLogin) return undefined;
  const repos = settings.repos ?? [];
  const fullName = repo.full_name.toLowerCase();
  if (repos.length && !repos.some(entry => entry.toLowerCase() === fullName || (entry.endsWith("/*") && fullName.startsWith(entry.slice(0, -1).toLowerCase())))) return undefined;

  const action = typeof payload.action === "string" ? payload.action : "";
  const mentions = (body: unknown) => typeof body === "string" && !!account.slug && new RegExp(`(^|[^\\w/-])@${account.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(body);
  let issue: any, isPull = false, text: string, association: unknown, coalesce: Inbound["coalesce"];
  const who = `@${sender.login}`;
  if (event === "pull_request") {
    const pull = payload.pull_request;
    if (!pull || !events.includes(`pull_request.${action}`)) return undefined;
    if (pull.draft && (settings.ignoreDrafts ?? true)) return undefined;
    issue = pull; isPull = true;
    // The pull request's author's standing, which is the sender's only when they are the author.
    association = pull.user?.login === sender.login ? pull.author_association : undefined;
    const refs = `Base: ${pull.base?.ref} ← head: ${pull.head?.ref} (${String(pull.head?.sha ?? "").slice(0, 12)})`;
    if (action === "synchronize") {
      text = [`${who} pushed new commits to pull request ${repo.full_name}#${pull.number}: ${pull.title}`, `${pull.html_url}`,
        `Head is now ${String(payload.after ?? pull.head?.sha ?? "").slice(0, 12)} (was ${String(payload.before ?? "").slice(0, 12)}).`, refs].join("\n");
      // Pushes in quick succession start one turn, on the latest.
      const debounceMs = (settings.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS) * 1000;
      if (debounceMs) coalesce = { key: `sync:${installation}-${repo.id}-${pull.number}`, debounceMs };
    } else {
      const verb = { opened: "opened", reopened: "reopened", ready_for_review: "marked ready for review" }[action as "opened"];
      text = [`${who} ${verb} pull request ${repo.full_name}#${pull.number}: ${pull.title}`, `${pull.html_url}`, refs,
        ...(pull.body ? ["", "Description:", truncate(String(pull.body), MAX_BODY_TEXT)] : [])].join("\n");
    }
  } else if (event === "issues") {
    if (!payload.issue || !events.includes(`issues.${action}`)) return undefined;
    issue = payload.issue;
    association = issue.user?.login === sender.login ? issue.author_association : undefined;
    text = [`${who} opened issue ${repo.full_name}#${issue.number}: ${issue.title}`, `${issue.html_url}`,
      ...(issue.body ? ["", truncate(String(issue.body), MAX_BODY_TEXT)] : [])].join("\n");
  } else if (event === "issue_comment" || event === "pull_request_review_comment") {
    const comment = payload.comment;
    if (action !== "created" || !comment || !events.includes(event) || !mentions(comment.body)) return undefined;
    issue = event === "issue_comment" ? payload.issue : payload.pull_request;
    if (!issue) return undefined;
    isPull = event === "pull_request_review_comment" || !!issue.pull_request;
    association = comment.author_association;
    const where = event === "pull_request_review_comment" && comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
    const hunk = event === "pull_request_review_comment" && typeof comment.diff_hunk === "string" ? ["", "```diff", comment.diff_hunk.split("\n").slice(-20).join("\n"), "```"] : [];
    text = [`${who} commented${where} on ${isPull ? "pull request" : "issue"} ${repo.full_name}#${issue.number} (${issue.title}):`, `${comment.html_url}`, ...hunk,
      "", truncate(String(comment.body), MAX_BODY_TEXT)].join("\n");
  } else return undefined;
  if (typeof issue.number !== "number") return undefined;

  const conversationId = `${installation}-${repo.id}-${issue.number}`;
  const files: InboundFile[] = isPull ? [{ id: `${installation}:${repo.id}:${issue.number}`, name: `pr-${issue.number}.diff`, contentType: "text/x-diff" }] : [];
  const trusted = settings.authors === "members" && MEMBERS.has(String(association ?? ""));
  return {
    conversationId, messageId: delivery,
    sender: { id: String(sender.id), username: sender.login },
    text: `[From GitHub]\n${text}${isPull ? "\n\nThe pull request's current diff is attached." : ""}`,
    files, title: truncate(`${repo.full_name}#${issue.number}: ${issue.title ?? ""}`, 110),
    ...(trusted ? { trusted } : {}), ...(coalesce ? { coalesce } : {}),
  };
}
