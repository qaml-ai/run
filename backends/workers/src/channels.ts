import { agentStore, insideRepo } from "./repos/agent-store.ts";
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { signRepoLink } from "./repos/links.ts";
import { readAttachment } from "./repos/attachments.ts";
import { Channels, type ChannelProvider, type ChannelRun, type ChannelsHost, type Presented } from "../../../src/core/channels/channels.ts";
import { telegram } from "../../../src/core/channels/telegram.ts";
import { slack } from "../../../src/core/channels/slack.ts";
import { github } from "../../../src/core/channels/github.ts";
import { webhook } from "../../../src/core/channels/webhook.ts";
import { emailProvider, replySubject, type OutgoingMail } from "../../../src/core/channels/email.ts";
import { FILE_LIMITS } from "../../../src/limits.ts";
import type { Env } from "./agent-types.ts";
import { Directory } from "./control.ts";
import { upsertAgent } from "./agent-upsert.ts";
import { resolveAgentKey } from "./agent-key.ts";
import { provisionDefinition, resolveDefinition } from "./definitions.ts";
import { configuration } from "./api-contract.ts";
import { keyServices } from "./security-services.ts";
import { decisionService, type DecisionEnv } from "./decision-service.ts";
import { handleAgentFilesRoute, volume, type AgentMount as Mount } from "./files.ts";
import { normalizePath } from "./volume-policy.ts";
import { signVolumeLink } from "./file-links.ts";
import { transaction, withSql, type Sql } from "./postgres.ts";
import { safeError } from "./observability.ts";
import { SendError } from "../../../src/core/channels/channels.ts";
import { workerGitHubApps, type GitHubAppsEnv } from "./github-apps.ts";

/**
 * Channels on Workers: the shared logic (src/core/channels) with this backend's host.
 *
 * Inbound webhooks hit the front Worker (`POST /channels/:type/:id`), which verifies the
 * delivery, records it in Postgres (the seen marker and the item commit together, so a
 * provider's retry is dropped) and answers; the message is then advanced in the request's
 * waitUntil: rate limits, the filter, the conversation's agent (created on first contact),
 * attachments into its workspace, and the prompt submitted to the agent's Durable Object
 * under the item's id, so a retried submission is the same run. Email arrives the same way
 * through the Email Worker handler (channel-email.ts).
 *
 * Nothing runs between messages: there is no scan loop and no object kept awake. Work that
 * comes due later (a retry, a debounce, a turn whose end was not seen) wakes a scan through
 * the queue at its time, and the five-minute cron scans as a backstop. Replies go out from
 * the agent's object when its turn ends (agent-channels.ts), through each service's API.
 */

type ChannelEnv = Env & DecisionEnv & {
  AGENT_TELEGRAM_API_URL?: string; AGENT_SLACK_API_URL?: string; AGENT_GITHUB_API_URL?: string;
  AGENT_CHANNEL_RETRY_MS?: string; AGENT_CHANNEL_RECHECK_MS?: string;
  /** Local tests only (with TEST_MODE): the size past which Slack gets a link in place of a file. */
  AGENT_TEST_SLACK_MAX_FILE_BYTES?: string;
  /** The domain Email Routing receives channel mail for (in.camelai.dev); no email channels without it. */
  AGENT_EMAIL_DOMAIN?: string;
  /** The Email Service binding replies are sent with. */
  EMAIL?: SendEmail;
  /** Local tests only: a loopback sink that takes the reply as JSON in place of Email Service. */
  TEST_CHANNEL_MAIL_URL?: string;
  TEST_MODE?: string;
};

/** Who claims items here: one id per isolate, so a crashed invocation's claims lapse and another retakes them. */
let node: string | undefined;
/** Made at first use: random values are not allowed in a Worker's global scope. */
const NODE = () => node ??= `worker-${crypto.randomUUID()}`;
/** Queue delays top out at 12 hours; later work waits for the cron. */
const MAX_DELAY_S = 43_200;
/** Email Service takes 5 MiB a message (attachments base64-encoded) to arbitrary recipients; larger files go as links. */
const EMAIL_FILE_BYTES = 3 * 1024 * 1024;
/** Stored raw mail lives under this prefix in the files bucket (channel-email.ts). */
export const STORED_MAIL_PREFIX = "channel-mail/";

/** Errors Cloudflare Email Service gives that a retry will not fix. */
const EMAIL_PERMANENT = /^E_(VALIDATION_ERROR|FIELD_MISSING|TOO_MANY_RECIPIENTS|TOO_MANY_ATTACHMENTS|CONTENT_TOO_LARGE|SENDER_NOT_VERIFIED|SENDER_DOMAIN_NOT_AVAILABLE|RECIPIENT_NOT_ALLOWED|RECIPIENT_SUPPRESSED|ACCOUNT_SUSPENDED|HEADER_|HEADERS_TOO_)/;

/** One GitHub provider per isolate and API, so an installation token (and a repository's name) is reused across deliveries and replies, as on ECS. */
const githubProviders = new Map<string, ChannelProvider>();
function githubFor(env: ChannelEnv, apiUrl: string, fetcher: typeof fetch): ChannelProvider {
  // A channel may name one of the tenant's stored GitHub Apps; those are read from this database.
  const key = `${env.HYPERDRIVE.connectionString}|${apiUrl}`;
  let provider = githubProviders.get(key);
  if (!provider) {
    if (githubProviders.size > 16) githubProviders.clear();
    githubProviders.set(key, provider = github({ ...(apiUrl ? { apiUrl } : {}), fetch: fetcher, apps: async (tenant, ref) => (await workerGitHubApps(env as unknown as GitHubAppsEnv)).credentials(tenant, ref) }));
  }
  return provider;
}

function providers(env: ChannelEnv, outbound: Awaited<ReturnType<typeof keyServices>>["outbound"]): Record<string, ChannelProvider> {
  // The shared providers refuse redirects themselves (src/core/no-redirect.ts).
  const fetcher = ((input: string, init?: RequestInit) => fetch(input, init)) as typeof fetch;
  return {
    telegram: telegram({ apiUrl: env.AGENT_TELEGRAM_API_URL, fetch: fetcher }),
    slack: slack({ apiUrl: env.AGENT_SLACK_API_URL, fetch: fetcher, ...(env.TEST_MODE === "1" && Number(env.AGENT_TEST_SLACK_MAX_FILE_BYTES) ? { maxFileBytes: Number(env.AGENT_TEST_SLACK_MAX_FILE_BYTES) } : {}) }),
    github: githubFor(env, env.AGENT_GITHUB_API_URL ?? "", fetcher),
    webhook: webhook({ outbound: { check: url => outbound.check(url), fetch: (url, init) => outbound.fetch(url, init as never) } }),
    ...(env.AGENT_EMAIL_DOMAIN ? { email: emailProvider({
      sql: { query: (text, values) => withSql(env, sql => sql.query(text, values as unknown[])) }, domain: env.AGENT_EMAIL_DOMAIN,
      setsMessageId: false, maxFileBytes: EMAIL_FILE_BYTES,
      deliver: mail => sendChannelMail(env, mail),
      async stored(ref) {
        if (!ref.startsWith(`r2:${STORED_MAIL_PREFIX}`)) throw new Error("Not a stored email attachment");
        const object = await env.BUCKET.get(ref.slice(3));
        if (!object) throw new Error("Stored mail is gone");
        return new Uint8Array(await object.arrayBuffer());
      },
    }) } : {}),
  };
}

/** A reply through Cloudflare Email Service (the send_email binding): threaded by In-Reply-To and References, from the channel's address. */
async function sendChannelMail(env: ChannelEnv, mail: OutgoingMail): Promise<{ messageId?: string }> {
  const builder: EmailMessageBuilder = {
    from: mail.fromName ? { email: mail.from, name: mail.fromName } : mail.from,
    to: mail.to, subject: replySubject(mail.subject), text: mail.text || " ",
    headers: {
      ...(mail.inReplyTo ? { "In-Reply-To": `<${mail.inReplyTo}>` } : {}),
      ...(mail.references.length ? { References: mail.references.map(id => `<${id}>`).join(" ") } : {}),
      ...mail.headers,
    },
    ...(mail.file ? { attachments: [{ disposition: "attachment", filename: mail.file.name, type: mail.file.contentType || "application/octet-stream", content: mail.file.data }] } : {}),
  };
  if (env.TEST_MODE === "1" && env.TEST_CHANNEL_MAIL_URL) {
    const url = new URL(env.TEST_CHANNEL_MAIL_URL);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("The channel mail fake must be loopback");
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      ...builder, attachments: mail.file ? [{ filename: mail.file.name, type: mail.file.contentType, content: toBase64(mail.file.data) }] : [],
    }) }).catch(error => { throw new SendError(`Email send failed: ${(error as Error).name}`, false); });
    if (!response.ok) throw new SendError(`Email send failed: HTTP ${response.status}`, response.status >= 400 && response.status < 500 && response.status !== 429);
    return await response.json() as { messageId?: string };
  }
  if (!env.EMAIL) throw new SendError("Email Sending is not configured (the EMAIL binding)", true);
  try { return await env.EMAIL.send(builder); }
  catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    throw new SendError(`Email send failed: ${code || (error as Error).name}`, EMAIL_PERMANENT.test(code));
  }
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

/** The agent's request record as the DO answers it, or an error carrying its status. */
async function agentCall(env: Env, agent: string, path: string, init: RequestInit = {}) {
  const response = await env.AGENTS.getByName(agent).fetch(new Request(`https://agent${path}`, init));
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(value.error ?? `Agent answered ${response.status}`)), { status: response.status, ...(typeof value.code === "string" ? { code: value.code } : {}) });
  return value;
}

async function entryFor(env: Env, agent: string, tenant: string) {
  const entry = await new Directory(env, tenant).get(agent);
  if (!entry || entry.deleted) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) return undefined;
  return entry;
}

/** The scratch mount files are uploaded to, as prompt attachments choose it. */
async function mountsOf(env: Env, agent: string, tenant: string): Promise<Mount[]> {
  const entry = await entryFor(env, agent, tenant);
  if (!entry) throw Object.assign(new Error("Unknown agent"), { status: 404 });
  return (entry.config.mounts ?? []) as Mount[];
}

function resolve(mounts: Mount[], path: string) {
  const absolute = normalizePath(path);
  const mount = [...mounts].sort((a, b) => b.path.length - a.path.length).find(m => absolute === m.path || absolute.startsWith(`${m.path}/`));
  if (!mount) throw Object.assign(new Error(`${absolute} is not inside a mount`), { status: 400 });
  return { mount, absolute, inside: normalizePath(`${mount.subpath ?? "/"}/${absolute.slice(mount.path.length)}`) };
}

/**
 * The shared channels with this backend's host. `background` keeps work going after a response (a request's or an
 * object's waitUntil); without it work is awaited where it starts.
 */
export async function workerChannels(env: Env, background?: (work: Promise<unknown>) => void): Promise<Channels> {
  const channelEnv = env as ChannelEnv;
  const { accounts, outbound } = await keyServices(env);
  const publicUrl = (env.AGENT_PUBLIC_URL || env.PUBLIC_URL || "").replace(/\/+$/, "");
  const decisions = decisionService(env as Env & DecisionEnv, async () => { throw new Error("Channel decisions name their tenant"); });
  const host: ChannelsHost = {
    sql: { query: (text, values) => withSql(env, sql => sql.query(text, values as unknown[])) },
    transaction: (work, options) => transaction(env, sql => work(sql as Sql), options),
    node: NODE(), publicUrl, providers: providers(channelEnv, outbound),
    keys: { canStore: accounts.canStoreKeys, seal: (context, text) => accounts.seal(context, text), unseal: (context, sealed) => accounts.unseal(context, sealed) },
    definitions: {
      read: async (tenant, id) => {
        const definition = await resolveDefinition(env, tenant, id);
        return { id: definition.id, spec: definition.spec as { channel?: string; dataCollection?: unknown } };
      },
      create: async (tenant, input, internal) => {
        const id = `def_${[...crypto.getRandomValues(new Uint8Array(10))].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
        const spec = { ...configuration({}, env.MODEL).config, ...internal } as Record<string, unknown>;
        delete spec.model;
        const now = Date.now();
        await withSql(env, sql => sql.query("insert into definitions(id,tenant,name,spec,revision,created_at,updated_at) values($1,$2,$3,$4,1,$5,$5)", [id, tenant, input.name.trim() || "Channel", JSON.stringify(spec), now]));
        return { id };
      },
      remove: async (tenant, id) => {
        const used = (await withSql(env, sql => sql.query("select id from channels where tenant = $1 and channel->>'definition' = $2 limit 1", [tenant, id]))).rows[0];
        if (used) throw Object.assign(new Error(`Channel ${used.id} uses this definition; point it at another first`), { status: 409 });
        await withSql(env, sql => sql.query("delete from definitions where tenant=$1 and id=$2", [tenant, id]));
      },
    },
    async createAgent(tenant, params, key) {
      const input = await provisionDefinition(env, tenant, params);
      configuration(input, env.MODEL);
      const { entry } = await upsertAgent(env, tenant, input, key, publicUrl);
      if ("failed" in entry && entry.failed) throw Object.assign(new Error(entry.error), { status: entry.status, code: entry.code });
      return { id: (entry as { id: string }).id };
    },
    agentId: (tenant, key) => resolveAgentKey(env, tenant, key),
    live: async (agent, tenant) => !!await entryFor(env, agent, tenant),
    async submit(agent, tenant, request) {
      if (!await entryFor(env, agent, tenant)) throw Object.assign(new Error("Agent is gone"), { status: 410 });
      return await agentCall(env, agent, "/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }) as unknown as ChannelRun;
    },
    files: {
      async upload(agent, tenant, requestId, name, source, contentType) {
        const mounts = await mountsOf(env, agent, tenant);
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            try { for await (const chunk of source) controller.enqueue(chunk); controller.close(); }
            catch (error) { controller.error(error); }
          },
        });
        const response = await handleAgentFilesRoute(new Request(`https://agent/uploads/${encodeURIComponent(requestId)}/${encodeURIComponent(name)}`, {
          method: "PUT", body, headers: contentType ? { "content-type": contentType } : {}, duplex: "half",
        } as RequestInit), env, tenant, agent, mounts);
        const value = await response!.json() as { path?: string; error?: string };
        if (!response!.ok || !value.path) throw Object.assign(new Error(value.error ?? "Upload failed"), { status: response!.status });
        return { path: value.path };
      },
      async ref(agent, tenant, path) {
        const { mount, absolute, inside } = resolve(await mountsOf(env, agent, tenant), path);
        // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
        if('volumeId'in mount) {
          const v=await volume(env,tenant,mount.volumeId,mount.volumeId===`agent:${agent}`),file=await v.stat(inside);
          await v.pin(`agent:${agent}`,[file.key]);
          return {type:'file',path:absolute,volume:mount.volumeId,version:file.version,key:file.key,size:file.size,contentType:file.contentType} as Presented;
        }
        const v = await agentStore(env as RepoEnv, tenant, mount.repo, mount.ref??"main",agent);
        let file;
        try { file = await v.stat(inside); }
        catch { throw Object.assign(new Error(`${absolute} does not exist`), { status: 400 }); }
        return {type:"file",path:absolute,repo:mount.repo,repoPath:insideRepo(inside),version:file.version,blob:file.blob,size:file.size,contentType:file.contentType} as Presented;
      },
      read(tenant, ref) {
        return (async function* () {yield await readAttachment(env as RepoEnv,tenant,ref as any);})();
      },
      async link(agent, tenant, path) {
        const { mount, inside } = resolve(await mountsOf(env, agent, tenant), path);
        // TEMPORARY(volume-fork-mounts): removed by the workflows-on-branches PR
        if('volumeId'in mount)return signVolumeLink(env,publicUrl,tenant,mount.volumeId,{path:inside,expiresIn:FILE_LIMITS.maxLinkSeconds}).url;
        const ctx=await repoContext(env as RepoEnv,tenant,mount.repo),v=await ctx.stub.resolve(mount.ref??"main");
        return (await signRepoLink(ctx,publicUrl,{path:insideRepo(inside),version:v.version,expiresIn:FILE_LIMITS.maxLinkSeconds})).url;
      },
    },
    isFile: value => !!value && typeof value === "object" && (value as Presented).type === "file" && typeof (value as Presented).path === "string"
      && (typeof (value as { blob?: unknown }).blob === "string" || typeof (value as {key?:unknown}).key === "string") && Number.isSafeInteger((value as Presented).size),
    inputs: {
      async pending(agent) {
        const response = await env.AGENTS.getByName(agent).fetch(new Request("https://agent/inputs?state=pending"));
        if (!response.ok) return [];
        const inputs = await response.json() as { id: string; requestId: string; kind: string; message: string; detail: Record<string, unknown>; createdAt: number; blocking?: boolean }[];
        return inputs.filter(input => input.blocking !== false).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      },
      answer: (agent, _tenant, input, answer) => agentCall(env, agent, `/inputs/${encodeURIComponent(input)}`, {
        method: "POST", headers: { "content-type": "application/json", "x-camel-input-via": "channel" }, body: JSON.stringify(answer),
      }),
    },
    decisions: {
      available: async tenant => decisions.decider.available(tenant, undefined),
      ask: async (tenant, request, signal) => {
        const { items: [item], model, actor, dataCollection } = request;
        return decisionService(env as Env & DecisionEnv, async () => ({ tenant })).run(
          { state: item!.state, questions: item!.questions, model }, signal,
          { actor, ...(dataCollection === "deny" ? { dataCollection: "deny" as const } : {}) });
      },
    },
    background: background ?? (() => {}),
    wake: due => {
      const delaySeconds = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      if (delaySeconds > MAX_DELAY_S || !env.WEBHOOKS) return;
      const sent = env.WEBHOOKS.send({ id: "channels", kind: "channels" }, { delaySeconds }).catch(error => console.error(JSON.stringify({ type: "channel_wake_failed", error: safeError(error) })));
      (background ?? (() => {}))(sent);
    },
    ...(channelEnv.AGENT_CHANNEL_RETRY_MS ? { retryBaseMs: Number(channelEnv.AGENT_CHANNEL_RETRY_MS) } : {}),
    ...(channelEnv.AGENT_CHANNEL_RECHECK_MS ? { recheckMs: Number(channelEnv.AGENT_CHANNEL_RECHECK_MS) } : {}),
    safeError,
    // A sub-agent's notice names the sub-agent (metadata.agentId); the run that started it is in its directory entry.
    parentRun: async (agent, run) => {
      const child = typeof run.metadata?.agentId === "string" ? run.metadata.agentId : undefined;
      const entry = child ? await new Directory(env, agent.tenant).get(child) : null;
      return entry?.parentAgentId === agent.id ? entry.parentRunId : undefined;
    },
  };
  return new Channels(host);
}
