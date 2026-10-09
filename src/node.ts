import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { AgentSupervisor } from "./supervisor.ts";
import type { NodeConfig } from "./node-config.ts";
import { configuredModel, defaultModels } from "./model.ts";
import { errorText, IDENTITY_KEY, SCOPE_KEY } from "./protocol.ts";
import { checkScope, KeyScopes } from "./key-scopes.ts";
import { ENDPOINTS_CHANNEL, Subscribers, Webhooks } from "./webhooks.ts";
import { Telemetry, TELEMETRY_CHANNEL } from "./telemetry.ts";
import { expireIdempotencyKeys } from "./idempotency.ts";
import { DOCS_SITE, loadDocs, loadRegistry, SKILL_PATHS } from "./docs.ts";
import { StorageGc } from "./storage-gc.ts";
import { modelHeadersInput, resolveModel, sessionConfig } from "./session-config.ts";
import { ClientSessions, ORPHANS_CHANNEL, runSessionOf, spendInput, type RunSettings, type SessionHooks } from "./client-sessions.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";
import type { LogTail, Storage, StorageMeter } from "../shared/storage.ts";
import { StorageUsage } from "./storage-usage.ts";
import { postgresTail, sweepTails } from "./log-tail.ts";
import { databaseFromEnvironment, listenFromEnvironment, migrate, type Db } from "./db.ts";
import { network, REAL_CLOCK, REAL_NETWORK, REAL_RANDOM, runFor, type Clock, type Network, type Random } from "./node-context.ts";
import { Ownership, probeNode } from "./ownership.ts";
import { BusyAgents } from "./busy-agents.ts";
import { tenantsFromEnvironment, type Tenants } from "./tenants.ts";
import { Accounts } from "./accounts.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { BillingMailer, billingMailConfig } from "./billing-mailer.ts";
import { Help, helpConfig } from "./help.ts";
import { MailTransport } from "./mail-transport.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { emailAt, Journey, JOURNEY_META, journeyApp, journeyConfig } from "./journey.ts";
import { Passwords } from "./passwords.ts";
import { AccountMail, accountMailConfig } from "./account-mail.ts";
import { EmailAccounts } from "./email-accounts.ts";
import { OAuth } from "./oauth.ts";
import { hostedMcp } from "./hosted-mcp.ts";
import { agentMcp } from "./agent-mcp.ts";
import { api } from "./api.ts";
import { Scheduler } from "./scheduler.ts";
import { Channels } from "./channels.ts";
import { Definitions, sources, validTtl } from "./definitions.ts";
import { ModelProviders } from "./model-providers.ts";
import { providerInfo } from "./catalog.ts";
import { outboundFromEnvironment } from "./outbound.ts";
import { McpConnections } from "./mcp.ts";
import { ToolSources } from "./tool-sources.ts";
import { applicationTools } from "./mcp-results.ts";
import { telegram } from "./channels-telegram.ts";
import { slack } from "./channels-slack.ts";
import { discord } from "./channels-discord.ts";
import { ManagedDiscord } from "./discord-managed.ts";
import { github as githubChannel } from "./channels-github.ts";
import { webhook } from "./channels-webhook.ts";
import { email, emailReceiver, type EmailOptions } from "./channels-email.ts";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { errorCode, errorFields, errorHeaders, errorStatus, HttpError, readJson, readText, signInHint } from "./http.ts";
import { outcomeEnding, type RequestRecord } from "../shared/client-protocol.ts";
import type { HistoryPage } from "./history-pages.ts";
import { VersionConflict, VolumeService } from "./volumes.ts";
import { FILE_LIMITS, FileLinks } from "./files.ts";
import { nodeLoadLine, nodeUrl, supersession, taskAddress, TaskProtection } from "./ecs.ts";
import { recordCreate, safeError, Steps, webhookBacklogLine } from "./metrics.ts";
import { runtimeSecrets, managedDiscordSecrets } from "./secrets.ts";
import { checkSandbox, type CodeExecutor } from "./codemode.ts";
import { V8Exec } from "./v8-exec.ts";
import { pricingFromEnvironment } from "./pricing.ts";
import { openaiTranscription, Transcriber } from "./transcription.ts";
import { Imager, openaiImages } from "./images.ts";
import { searchProvidersFromEnvironment, WebSearch } from "./web-search.ts";
import { WebRender } from "./web-render.ts";
import { Stripe } from "./stripe.ts";
import { identityInput, RuntimeSigner } from "./identity.ts";
import { FileUrls } from "./file-arguments.ts";
import { builtinsInput, builtinWarnings } from "./builtins.ts";
import { delegateSettings } from "./multi-agent.ts";
import { rerankersFromEnv } from "./tool-search.ts";
import { Inputs, inputView } from "./inputs.ts";
import { BrowserTokens } from "./browser-tokens.ts";
import { publicOrigins } from "./origins.ts";
import { adminSite, adminSiteFromEnvironment } from "./admin-site.ts";
import { AccountDeletions } from "./account-deletion.ts";
import { RateLimits, rateLimitConfig } from "./rate-limits.ts";
import { buggify } from "./buggify.ts";
import { sometimes } from "./assert.ts";

/**
 * What a node is given rather than finds for itself: its operators' tenants, its secrets, the control-plane database and
 * how to listen on it, the sandbox it checked, and on ECS its task's address, whether a newer deployment replaced it, and
 * managed Discord's credentials. `nodeDeps` makes the real ones from a node's configuration.
 */
export type NodeDeps = {
  tenants: Tenants;
  secrets: RuntimeSecrets;
  /** The control-plane pool; the node ends it when it closes. */
  db: Db;
  /** Listen for notifications on each channel of `handlers` over a connection of its own (listenFromEnvironment). */
  listen: (handlers: Record<string, (payload: string) => void>) => Promise<{ close(): Promise<void> }>;
  /** Where js_exec and file parsing run (checkSandbox), reported in the "listening" line. */
  sandbox: Record<string, unknown>;
  /** This task's private address on ECS, where peers reach it. */
  address?: string;
  /**
   * On ECS, a check of whether a newer deployment of this task's service has replaced it (undefined off ECS). Looked up
   * once the node has started listening, so an ECS metadata fetch never delays that.
   */
  supersession?: () => Promise<(() => Promise<"current" | "waiting" | "superseded">) | undefined>;
  /** Managed Discord's credentials, read where the node sets up its channels (undefined: managed Discord is off). */
  managedDiscord?: () => Promise<ManagedDiscordSecrets | undefined>;
  /**
   * How the node reaches other nodes and the outside world, its time and its randomness (src/node-context.ts): the real
   * ones unless given. A node given any runs in a context of its own, so its code finds them wherever it runs, and
   * several can share a process.
   */
  network?: Network;
  clock?: Clock;
  random?: Random;
  /** Where inline agents run js_exec: this process's v8-exec runner unless given (src/codemode.ts). */
  codeExecutor?: CodeExecutor;
  /**
   * The data plane every node shares, given the node's log tail and storage meter: AGENT_STORAGE's unless given (a
   * simulation's in-memory store).
   */
  storage?: (tail: LogTail, meter: StorageMeter) => Storage | Promise<Storage>;
};
type RuntimeSecrets = Awaited<ReturnType<typeof runtimeSecrets>>;
type ManagedDiscordSecrets = NonNullable<Awaited<ReturnType<typeof managedDiscordSecrets>>>;

/** Derives client session tokens. It must stay stable, or re-provisioning returns tokens that no longer verify. */
function sessionSecretOf(secrets: RuntimeSecrets) {
  const secret = secrets.sessionSecret;
  if (!secret || secret.length < 32) throw new Error("Set AGENT_SESSION_SECRET (or AGENT_SESSION_SECRET_ARN) to at least 32 random characters");
  return secret;
}

/** The real dependencies, from a node's environment; checked in the order the server always checked them. */
export async function nodeDeps(config: NodeConfig): Promise<NodeDeps> {
  const { env } = config;
  // Tenants (operator token hashes and provider keys) come from AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN.
  const tenants = await tenantsFromEnvironment(env);
  const secrets = await runtimeSecrets(env);
  sessionSecretOf(secrets);
  // Fails startup if js_exec or file parsing does not work, or if isolation is required but absent.
  // The node's js_exec runner, which inline agents use (agent processes start their own, from agentEnv).
  const codeExecutor = new V8Exec(config.v8);
  const sandbox = await checkSandbox({ executor: codeExecutor, required: config.sandboxRequired });
  const db = await databaseFromEnvironment(env);
  const address = await taskAddress(env);
  return {
    tenants, secrets, db, listen: handlers => listenFromEnvironment(handlers, env), sandbox, address, codeExecutor,
    supersession: () => supersession(env), managedDiscord: () => managedDiscordSecrets(env),
  };
}

/** A runtime node: its HTTP surface, and the handles that start it and take it out of the cluster. */
export type RuntimeNode = {
  /** The URL peers reach this node at, which it heartbeats and owns actors under. */
  node: string;
  app: Hono<Env>;
  /** The HTTP server around `app`, listening once `start` resolves. */
  server: Server;
  /** Listen on the configured host and port. */
  start(): Promise<AddressInfo>;
  /**
   * Leave the cluster without dropping work (what SIGTERM does): turns are handed to peers or finish, for up to the
   * drain timeout, then everything is released and closed. Called again while draining, it stops waiting for turns.
   */
  drain(reason?: string): Promise<void>;
  /** Drain without waiting for running turns: they are released at once, their calls in flight of unknown outcome. */
  close(): Promise<void>;
  /** Read the tenants again (SIGHUP): a bad file or secret is rejected whole, and the tenants loaded before stay. */
  reloadTenants(): Promise<void>;
  /** Run `work` as this node: in its context, if it was given one (a simulation calling in), else as it is. */
  run<T>(work: () => T): T;
};
type Env = { Bindings: HttpBindings; Variables: { tenant: string } };

/**
 * Build one runtime node from its configuration and dependencies: it joins the cluster (migrations, heartbeat) and starts
 * its background work (sweeps, outboxes, schedules, billing) at once, and serves requests once started. Everything it
 * starts is its own and stops when it drains, so several nodes can share a process.
 */
export async function createNode(config: NodeConfig, deps: NodeDeps): Promise<RuntimeNode> {
  if (!deps.network && !deps.clock && !deps.random) return buildNode(config, deps);
  const context = { network: deps.network ?? REAL_NETWORK, clock: deps.clock ?? REAL_CLOCK, random: deps.random ?? REAL_RANDOM };
  const node = await runFor(context, () => buildNode(config, deps));
  return {
    ...node, start: () => runFor(context, node.start), drain: signal => runFor(context, () => node.drain(signal)),
    close: () => runFor(context, node.close), reloadTenants: () => runFor(context, node.reloadTenants), run: work => runFor(context, work),
  };
}

async function buildNode(config: NodeConfig, deps: NodeDeps): Promise<RuntimeNode> {
  const { env, root, port, maxAgents, maxAgentsPerTenant, retireMaxMs, leaseTtlMs, orphanMs, hosting, toolTimeoutMs, runLimits, streamTimeouts, runRetentionSeconds, idleMs, publicUrl, systemPrompt } = config;
  const { tenants, secrets, db, sandbox } = deps;
  const sessionSecret = sessionSecretOf(secrets);
  // How tools.search ranks: keywords alone, or fused with the operator's rerank stages.
  // The key: a dedicated one if set (AGENT_TOOL_SEARCH_API_KEY, or the tool-search secret), else the
  // platform's OpenRouter key from the tenants file, read at each search so a reload takes effect.
  const platformOpenRouter = () => tenants.platformKey("openrouter");
  const pricing = pricingFromEnvironment(env);
  const rerankers = rerankersFromEnv(env, secrets.toolSearchKey || platformOpenRouter, pricing.openrouterCreditMultiplier);
  if (rerankers.length && !secrets.toolSearchKey && !platformOpenRouter()) {
    console.error(JSON.stringify({ type: "tool_search_not_configured", reason: "no platformKeys.openrouter in the tenants file and no AGENT_TOOL_SEARCH_API_KEY; tools.search ranks by keywords until one is set" }));
  }
  // Control plane: coordination and small mutable state in Postgres.
  await migrate(db);
  // Data plane: logs and blobs in local files by default, or shared storage (S3) so any node can serve any agent.
  // Shared logs keep their recent records in Postgres until they are compacted into Storage.
  const storageDescriptor = storageFromEnvironment(root, env);
  // A durable flush while the database is away waits up to a lease for it; by then the node has fenced anyway.
  // What each agent, volume and tenant stores is tracked as objects are written and deleted, for the storage charge.
  const storageUsage = new StorageUsage(db);
  const tail = postgresTail(db, { retryMs: leaseTtlMs });
  const storage = deps.storage ? await deps.storage(tail, storageUsage.meter) : await openStorage(storageDescriptor, tail, storageUsage.meter);
  // Storage given to the node is shared, as S3 is.
  const distributed = !!deps.storage || storageDescriptor.kind === "s3" || !!(storageDescriptor.kind === "file" && storageDescriptor.shared);
  const node = nodeUrl(env, port, deps.address);
  // A peer whose heartbeat is late and whose address no longer accepts connections has died: its actors are freed at once.
  const ownership = new Ownership(db, { node, ttlMs: leaseTtlMs, alive: peer => probeNode(peer) });
  await ownership.start();
  // Local files are this host's alone: a second node on the same database would serve agents and volumes whose
  // logs it cannot see, with nothing to fence its writes. Wait out a peer that may have just died, then refuse.
  if (!distributed) {
    for (const deadline = Date.now() + leaseTtlMs; ;) {
      const peers = await ownership.livePeers();
      if (!peers.length) break;
      if (Date.now() >= deadline) throw new Error(`AGENT_STORAGE=file is for one node, but other nodes share this database (${peers.join(", ")}); use shared-file or s3 for several nodes`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  // Every call to a URL a tenant configured (MCP servers, web_fetch, model endpoints) goes through one guard: public addresses
  // only, but for origins the operator allows (AGENT_OUTBOUND_ALLOW_ORIGINS), which web_fetch, search and render never reach
  // (`withoutOrigins`).
  const outbound = outboundFromEnvironment(env);
  const supervisor = new AgentSupervisor(join(root, "sessions"), {
    runtime: config.runtime, maxAgents, hosting, ...(distributed ? { storage } : {}), ...(deps.codeExecutor ? { codeExecutor: deps.codeExecutor } : {}),
    agentEnv: config.agentEnv, historyBacklogBytes: config.historyBacklogBytes, modelOutbound: outbound,
  });
  const model = configuredModel(env);
  // Where people are sent (the public URL), other names served in full (an earlier domain), and the issuer tokens name.
  const origins = publicOrigins(env, `http://127.0.0.1:${port}`);
  // Tenant-set provider keys are encrypted with AGENT_SECRETS_KEY; without it tenants cannot store keys.
  // Prepaid tenants pay from credit at the rates in src/pricing.ts, which the environment may override.
  // Credit is bought through Stripe Checkout when Stripe is configured (AGENT_STRIPE_SECRET_ARN, or STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET).
  const stripe = secrets.stripe && new Stripe({ ...secrets.stripe, ...config.stripe });
  const accounts = new Accounts({ tenants, db, secretsKey: secrets.secretsKey, pricing, publicUrl, stripe, maxAgentsPerTenant });
  // Busy agents per tenant, counted across the fleet: each tenant's own maxAgents, its usage tier, or AGENT_MAX_AGENTS_PER_TENANT.
  const busyAgents = new BusyAgents({ db, ownership, limitFor: (tenant, sql) => accounts.billing.busyLimit(tenant, sql) });
  accounts.billing.autoTopup?.start();
  const billingAlerts = new BillingAlerts(db, accounts);
  const mailConfig = billingMailConfig(env);
  if (mailConfig && !accounts.canStoreKeys) throw new Error("Billing email requires AGENT_SECRETS_KEY for confirmation tokens");
  const billingMailer = mailConfig ? new BillingMailer({ db, alerts: billingAlerts, ...mailConfig }) : undefined;
  billingMailer?.start();
  // Get Help mails the support inbox when AGENT_SUPPORT_EMAIL and its sender are set, through the billing email provider.
  const supportConfig = helpConfig(env, mailConfig);
  const supportMail = supportConfig && new MailTransport(supportConfig.transport);
  const help = supportConfig && new Help({ ...supportConfig, db, accounts, alerts: billingAlerts, hashKey: sessionSecret, send: (mail, signal) => supportMail!.send(mail, signal) });
  const { minAccountDays, openSignup } = config;
  if (secrets.github && pricing.startingGrant > 0 && minAccountDays === undefined) throw new Error("Configure AGENT_SIGNUP_MIN_ACCOUNT_DAYS before enabling GitHub starting credit");
  const github = secrets.github && {
    ...secrets.github, org: config.github.org, open: openSignup, minAccountDays,
    webUrl: config.github.webUrl, apiUrl: config.github.apiUrl,
  };
  // Google sign-in admits any verified Google address, so it is sign-up for anyone: only with open sign-up.
  // Its tenants get starting credit only by verifying a card (src/card-credit.ts).
  if (secrets.google && !openSignup) throw new Error("Google sign-in lets anyone sign up; set AGENT_OPEN_SIGNUP=true to enable it, or remove its client");
  const google = secrets.google && { ...secrets.google, issuer: config.googleIssuer };
  // Rate limits (src/rate-limits.ts): per client address and per tenant. The per-address API budget is split among the
  // live nodes, recounted every 30 s.
  let liveNodes = 1;
  const countNodes = () => void ownership.livePeers().then(peers => { liveNodes = peers.length + 1; }, error => console.error(JSON.stringify({ type: "node_count_failed", error: safeError(error) })));
  countNodes();
  const nodesTimer = setInterval(countNodes, 30_000);
  nodesTimer.unref();
  const rateLimits = new RateLimits({
    db, config: rateLimitConfig(env), hashKey: sessionSecret, nodes: () => liveNodes,
    free: tenant => accounts.billing.onFreeCredit(tenant),
    override: (tenant, limit) => tenants.has(tenant) ? tenants.rateLimit(tenant, limit) : accounts.billing.rateLimit(tenant, limit),
    // Admin tenants (the operator's own applications, such as camelAI's) are never rate limited unless their entry sets a limit.
    exempt: tenant => tenants.has(tenant),
  });
  rateLimits.start();
  /** Who sent a request: its address and the key per-address limits count it under (none for the runtime's own calls). */
  const requestClient = (c: Context) => rateLimits.client(name => c.req.header(name), (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress);
  // Journey events for the operator's own analytics store: nothing unless AGENT_JOURNEY_URL is set (src/journey.ts).
  const journeySettings = journeyConfig(env, secrets.journeySecret);
  const journey = journeySettings && new Journey({
    db, publicUrl, ...journeySettings,
    internal: (tenant, email) => tenants.has(tenant) || emailAt(journeySettings.internalEmailDomains, email),
  });
  journey?.start(config.schedulerIntervalMs);
  accounts.billing.journey = journey;
  // Sign-up, password reset and adding a password by email, when AGENT_ACCOUNT_EMAIL_FROM configures account mail
  // (sign-up only with open sign-up). Without it none of them is offered.
  const accountMailSettings = accountMailConfig(env, publicUrl, openSignup);
  const accountMail = accountMailSettings && new AccountMail(accountMailSettings);
  const consoleAuth = new ConsoleAuth({
    accounts, publicUrl, github, google, passwords: new Passwords(db), journey,
    email: accountMail ? new EmailAccounts({ accounts, mail: accountMail, openSignup }) : undefined,
    emailLimit: (c, email) => rateLimits.emailRequest(requestClient(c).key, email),
    admitSignup: c => { const { key } = requestClient(c); return sql => rateLimits.signup(sql, key); },
    passwordLimits: { allowed: (c, email) => rateLimits.passwordAllowed(requestClient(c).key, email), failed: (c, email) => rateLimits.passwordFailed(requestClient(c).key, email) },
  });
  const { consoleDir } = config;

  const mcp = new McpConnections({ outbound });
  // Identity tokens for tool servers with auth "runtime", verified against /.well-known/jwks.json.
  const signer = new RuntimeSigner({ db, accounts, issuer: origins.issuer });
  // OAuth for the hosted MCP endpoints, under the same issuer.
  const oauth = new OAuth({ db, accounts, consoleAuth, secret: sessionSecret, origins, github: !!github, google: !!google });
  // web_search and web_fetch's renderer: the tenant's key for each provider, else an admin's, else the platform's (for a
  // prepaid tenant, or an admin tenant without platformKeys: false), whose calls a prepaid tenant pays for at that
  // provider's price. js_exec can make many calls between two model requests, so spent or rate-limited credit refuses
  // the platform's key at each call, not only at the next request.
  const webKey = async (tenant: string, provider: string) => {
    const resolved = await accounts.providerKey(tenant, provider);
    if (!resolved) return undefined;
    // Only the platform's own key is the platform's: an admin's key for the tenant (its apiKeys) is the tenant's to account for.
    const platform = resolved.source === "platform";
    if (platform) { const limited = await accounts.billing.creditLimit(tenant); if (limited) throw limited; }
    return { key: resolved.key, platform };
  };
  const search = new WebSearch({
    outbound: outbound.withoutOrigins(), ...searchProvidersFromEnvironment(env), key: webKey, timeoutMs: config.searchTimeoutMs,
    price: provider => accounts.billing.pricing.webSearch[provider],
    onSearch: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
  });
  const render = new WebRender({
    outbound: outbound.withoutOrigins(), key: webKey, price: accounts.billing.pricing.webRender, endpoint: config.firecrawlUrl,
    onRender: (tenant, agent, usage) => accounts.recordUsage(tenant, agent, usage),
  });
  // A provider's key for speech to text and images, as a model call resolves it: its key scope's, its own, else the
  // platform's, which a prepaid tenant pays for (per second of audio, per token of an image).
  const providerKey = async (tenant: string, keyScope: string | undefined, provider: string) => {
    const entry = keyScope ? await keyScopes.entry(tenant, keyScope, provider) : undefined;
    // A scope's entry, as its model calls take it: its key, or an address (a gateway) that needs none.
    if (entry?.apiKey || entry?.baseUrl) return { apiKey: entry.apiKey ?? "", ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}), ...(entry.headers ? { headers: entry.headers } : {}), platform: false };
    const resolved = await accounts.providerKey(tenant, provider);
    if (!resolved) return undefined;
    const platform = resolved.source !== "tenant";
    if (resolved.source === "platform") { const limited = await accounts.billing.creditLimit(tenant); if (limited) throw limited; }
    return { apiKey: resolved.key, platform };
  };
  // Speech to text, for audio attached to messages and POST /v1/transcriptions.
  const transcriber = new Transcriber({
    provider: openaiTranscription({ outbound, ...(env.AGENT_TRANSCRIPTION_URL ? { baseUrl: env.AGENT_TRANSCRIPTION_URL } : {}) }),
    key: providerKey,
    price: () => accounts.billing.pricing.transcription,
  });
  // Images made, for POST /v1/images.
  const imager = new Imager({
    provider: openaiImages({ outbound, ...(env.AGENT_IMAGES_URL ? { baseUrl: env.AGENT_IMAGES_URL } : {}) }),
    key: providerKey,
    price: () => accounts.billing.pricing.image,
  });
  // Files sent to tools as URLs bound to their call, signed with the identity tokens' key (file-arguments.ts).
  const fileUrls = new FileUrls({ signer, get volumes() { return volumes; }, publicUrl: () => links.publicUrl });
  const toolSources = new ToolSources({ accounts, mcp, outbound, signer, search, render, get scheduler() { return scheduler; }, get volumes() { return volumes; }, fileUrls });
  // Tenants' own OpenAI-compatible model providers.
  const modelProviders = new ModelProviders({ db, accounts, outbound });
  const definitions = new Definitions({ db, accounts, outbound, customProviders: tenant => modelProviders.resolvable(tenant) });
  // Saving a definition lists its MCP servers, as its agents would.
  definitions.listMcp = (tenant, id, servers) => toolSources.listed(tenant, id, servers);
  // Saving a definition, an agent or a managed Discord server warns of builtins the tenant has no key for.
  const warningsFor = (tenant: string, given: Parameters<typeof builtinWarnings>[0]) => builtinWarnings(given, search.options.order, () => accounts.keyedProviders(tenant));
  definitions.builtinWarnings = (tenant, spec) => warningsFor(tenant, sources(spec));
  const keyScopes = new KeyScopes({ db, accounts, outbound });
  const defaults = defaultModels(model, env.AGENT_MODEL_FALLBACKS);
  /** The model an agent of `tenant` that names none gets: the first default its key scope or tenant has a key for, else the first. */
  async function defaultModelFor(tenant: string, keyScope?: string) {
    const keyed = await accounts.keyedProviders(tenant);
    for (const candidate of defaults) if (keyed(candidate.provider) || (keyScope && await keyScopes.entry(tenant, keyScope, candidate.provider))) return candidate;
    return defaults[0];
  }
  modelProviders.onDelete = (tenant, name) => keyScopes.forgetProvider(tenant, name);
  // Each model response's usage, POSTed to the tenant's receiver from a durable outbox any node sends from.
  // Which tenants have endpoints for run events: runs of the others write none.
  const subscribers = new Subscribers(db);
  const telemetry = new Telemetry({
    db, accounts, outbound, service: config.serviceName,
    ...(config.telemetry.intervalMs !== undefined ? { intervalMs: config.telemetry.intervalMs } : {}),
    ...(config.telemetry.retryBaseMs !== undefined ? { retryBaseMs: config.telemetry.retryBaseMs } : {}),
  });
  telemetry.start();
  const webhooks = new Webhooks({ db, accounts, outbound, subscribers, ...(config.usageWebhookRetryMs !== undefined ? { retryBaseMs: config.usageWebhookRetryMs } : {}) });
  webhooks.start(config.schedulerIntervalMs);
  // Idempotency keys' answers are kept a day.
  const idempotencyTimer = setInterval(() => void expireIdempotencyKeys(db).catch(error => console.error(JSON.stringify({ type: "idempotency_expiry_failed", error: errorText(error) }))), 60 * 60_000);
  idempotencyTimer.unref();

  /**
   * Provision an agent for `tenant` (POST /v1/agents), recording how long each step took (`create_timing`). `parent` is the run
   * that made it with a delegate call: the runtime's own, never a caller's.
   */
  async function createAgent(tenant: string, params: any, key?: string, parent?: { agentId: string; runId: string; toolCallId: string; depth: number }, admit?: (unchanged: boolean) => Promise<unknown>, run?: RunSettings & { ttlMs: number }) {
    const steps = new Steps();
    const made: { agent?: string; upsert: boolean } = { upsert: false };
    try {
      const result = await provisionAgent(tenant, params, key, steps, made, parent, admit, run);
      recordCreate(steps, { tenant, ...made });
      return result;
    } catch (error) {
      recordCreate(steps, { tenant, ...made, error: safeError(error) });
      throw error;
    }
  }

  /** A parent agent's model as the runtime knows it: one of its defaults, or the catalog's of that name. */
  function parentModel(given: { provider?: unknown; id?: unknown; baseUrl?: unknown }) {
    const own = defaults.find(candidate => candidate.provider === given.provider && candidate.id === given.id && candidate.baseUrl === given.baseUrl);
    if (own) return own;
    try { return resolveModel(`${given.provider}/${given.id}`); } catch { return undefined; }
  }

  /** `admit` counts the create against the tenant's rate limit once the key's agent is known: told whether it changes nothing.
   * `run`: a stateless run's session (POST /v1/runs), which lives `ttlMs` at most and is never reconfigured. */
  async function provisionAgent(tenant: string, params: any, key: string | undefined, steps: Steps, outcome: { agent?: string; upsert: boolean }, parent?: { agentId: string; runId: string; toolCallId: string; depth: number }, admit?: (unchanged: boolean) => Promise<unknown>, run?: RunSettings & { ttlMs: number }) {
    // The application's tools are its attached MCP server's: the tools/list it declares.
    const { mcp: _mcp, subject: _subject, context: _context, keyScope, spendLimit: limit, modelHeaders: headers, builtins: asked, delegate: delegating, mcpServers: servers, remount, ...rest } = params ?? {};
    if (remount !== undefined && typeof remount !== "boolean") throw new HttpError(400, "remount must be true or false");
    // The application's tools as it declared them, whose hash its connections are told (`toolsHash`).
    const mcpTools = params?.mcp?.tools;
    // Who the agent acts for, and context for its tool servers' identity tokens.
    const identity = identityInput(params ?? {});
    if (keyScope !== undefined) checkScope(keyScope);
    // An agent's own built-in tools; one made from a definition has its definition's.
    if ((asked !== undefined || delegating !== undefined) && params.definition !== undefined) throw new HttpError(400, "builtins come from the definition; change them there");
    const builtins = asked === undefined ? undefined : builtinsInput(asked);
    // Its own MCP servers, without credentials (a definition seals those); one made from a definition has its definition's.
    if (servers !== undefined && params.definition !== undefined) throw new HttpError(400, "mcpServers come from the definition; change them there");
    const mcpServers = servers === undefined ? undefined : toolSources.inline(servers, tenant);
    // With the delegate builtin, who the agent may delegate to.
    const delegate = delegateSettings(builtins, delegating);
    const spendLimit = limit === undefined ? undefined : spendInput(limit) ?? undefined;
    const modelHeaders = headers === undefined ? null : modelHeadersInput(headers);
    // A delegate's inline child runs on its parent's model, which the runtime passes as it is. It is taken again from the
    // runtime's own defaults or the catalog by name: the parent's prices and endpoint are never copied.
    const inherited = parent && rest.model !== undefined && typeof rest.model !== "string" ? parentModel(rest.model) : undefined;
    if (inherited) delete rest.model;
    try { params = { ...rest, tools: applicationTools(params ?? {}) }; } catch (error) { throw new HttpError(400, errorText(error)); }
    // Its definition and the tenant's own providers are read at once.
    const [made, custom] = await Promise.all([
      params?.definition !== undefined ? steps.time("definition", definitions.provision(tenant, params)) : undefined,
      steps.time("providers", modelProviders.resolvable(tenant, keyScope)),
    ]);
    if (made) params = made.params;
    const fallback = inherited ?? (params.model === undefined ? await steps.time("providers", defaultModelFor(tenant, keyScope)) : model);
    const config = { ...sessionConfig(params, fallback, systemPrompt, tenants.modelEndpoints(tenant), custom), ...(modelHeaders ? { modelHeaders } : {}) };
    const ttl = params.ttlSeconds;
    validTtl(ttl);
    // An idle lifetime instead: the agent lives this long from its latest run.
    const idle = params.idleTtlSeconds;
    if (idle !== undefined && idle !== null) {
      if (!Number.isInteger(idle) || idle < 60 || idle > 366 * 86_400) throw new HttpError(400, "idleTtlSeconds must be an integer from 60 to 31622400, or null");
      if (ttl !== undefined && ttl !== null) throw new HttpError(400, "Give ttlSeconds (a lifetime from creation) or idleTtlSeconds (from its latest run), not both");
    }
    // An agent made with a key is one the application comes back to: it lives until deleted, unless it says otherwise.
    // One made without is a scratch agent nothing can find again once its id is lost: it lives a day, unless it says.
    const lifetime = run ? run.ttlMs : ttl === undefined ? (key !== undefined ? null : undefined) : ttl === null ? null : ttl * 1000;
    const { reconfigure, ...made_ } = await clients.create(params.tools ?? [], config, key, { name: params.name, type: params.type }, tenant, lifetime, params.mounts,
      made && { definition: made.ref, provision: made.provision, overrides: made.overrides, sources: made.sources }, identity,
      { keyScope, spendLimit, builtins, delegate, mcpServers, ...(remount ? { remount } : {}), ...(idle && !run ? { idleTtlMs: idle * 1000 } : {}), ...(parent ? { parent } : {}), ...(run ? { run: { retentionMs: run.retentionMs, fingerprint: run.fingerprint } } : {}), ...(mcpTools !== undefined ? { toolsHash: createHash("sha256").update(JSON.stringify(mcpTools)).digest("hex") } : {}), ...(admit ? { admit } : {}) }, steps);
    outcome.agent = made_.id;
    outcome.upsert = !!reconfigure;
    const warnings = await warningsFor(tenant, made ? made.sources : builtins && { builtins });
    if (warnings.length) made_.warnings = warnings;
    if (!reconfigure) return made_;
    // The key's agent exists: bring it to this configuration between its turns. Every upsert queues its own request, so
    // the last one sent wins; one whose configuration the agent has already changes nothing when it runs.
    const reconfigured = await steps.time("configure", submitAnywhere(made_.id, tenant, { id: `upsert-${randomUUID()}`, method: "configure", params: reconfigure as Record<string, unknown> }));
    return { ...made_, reconfigured };
  }

  const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
  /** Serve the console's static build; unknown paths get index.html for client-side routing. */
  async function serveConsole(c: Context) {
    const relative = normalize(decodeURIComponent(new URL(c.req.url).pathname.slice("/console/".length))).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(consoleDir, relative);
    let asset = !!relative && !relative.endsWith("/") && file.startsWith(consoleDir + sep);
    let body: Buffer | undefined;
    if (asset) {
      try { body = await readFile(file); } catch { asset = false; }
    }
    // Anything that is not a built file is a client-side route: serve the app shell.
    if (!body) {
      try { body = await readFile(join(consoleDir, "index.html")); }
      catch { return c.body("The console is not built on this host", 404, { "Content-Type": "text/plain" }); }
    }
    const type = asset ? CONTENT_TYPES[extname(file)] ?? "application/octet-stream" : CONTENT_TYPES[".html"];
    // Where journey events are on, the shell tells the console to report its pages, and a browser arriving from elsewhere is noted (src/journey.ts).
    if (!asset && journey) {
      body = Buffer.from(body.toString("utf8").replace("</head>", `${JOURNEY_META}</head>`));
      const { setCookie } = await journey.arrival(c.req.raw);
      if (setCookie) c.header("Set-Cookie", setCookie, { append: true });
    }
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": type,
      "Cache-Control": asset && relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
    });
  }

  /**
   * Where a request goes instead of here: the live owner elsewhere of the actor it
   * addresses, or while this node drains, a live peer for anything it does not hold.
   * Agents are `/clients/<id>`, `/v1/agents/<id>`, `/registry/<id>` or
   * `/internal/agents/<id>`; volumes are `/v1/volumes/<id>` or `/internal/volumes/<id>`.
   */
  async function route(url = ""): Promise<{ node: string; actor?: string } | undefined> {
    // A stateless run is its session's: run_<hex> is served where client_<hex> is.
    const run = /^\/v1\/runs\/(run_[a-f0-9]{40})(?:[/?]|$)/.exec(url)?.[1];
    const agent = run ? runSessionOf(run) : /^\/(?:clients|v1\/agents|registry|internal\/agents)\/(client_[a-f0-9]{40})(?:[/?]|$)/.exec(url)?.[1];
    const volume = agent ? undefined : /^\/(?:v1\/volumes|internal\/volumes)\/(vol_[a-f0-9]{24})(?:[/?]|$)/.exec(url)?.[1];
    const actor = agent ?? volume;
    if (actor) {
      const owner = await (agent ? clients.ownerElsewhere(agent) : volumes.ownerElsewhere(actor));
      return owner ? { node: owner, actor } : undefined;
    }
    const peer = ownership.draining ? await ownership.peer() : undefined;
    return peer ? { node: peer } : undefined;
  }

  /** Node-to-node requests are signed with the session secret all nodes share. */
  const internalSignature = (timestamp: string, path: string, body: string) =>
    createHmac("sha256", sessionSecret!).update(`internal:${timestamp}:${path}:${createHash("sha256").update(body).digest("hex")}`).digest("hex");

  function signedPost(owner: string, path: string, payload: unknown, timeoutMs = 15_000, signal?: AbortSignal) {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    return network().fetch(new URL(path, owner), {
      method: "POST", body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "x-agent-runtime-internal": `${timestamp}.${internalSignature(timestamp, path, body)}` },
    });
  }

  /** Read a node-to-node request's body, or undefined when its signature is missing, stale or wrong. */
  async function signedBody(c: Context): Promise<string | undefined> {
    const body = await readText(c.req.raw.body, 1_100_000);
    const [timestamp, signature] = (c.req.header("x-agent-runtime-internal") ?? "").split(".");
    const expected = Buffer.from(internalSignature(timestamp ?? "", c.req.path, body));
    const given = Buffer.from(signature ?? "");
    sometimes(!!timestamp && Math.abs(Date.now() - Number(timestamp)) > 5_000, "a node-to-node request came from a node whose clock is seconds off");
    if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 60_000 || expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return body;
  }

  /** Submit a request to an agent wherever it is served: here, or on the node that owns it. */
  async function submitAnywhere(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) {
    const owner = await clients.ownerElsewhere(agent);
    if (!owner) return clients.submit(agent, tenant, request);
    const response = await signedPost(owner, `/internal/agents/${agent}/requests`, { tenant, request }).catch(error => { ownership.forget(agent); throw error; });
    if (!response.ok) {
      ownership.forget(agent);
      // Its code and details (a limit, say) reach the caller as the owner gave them.
      const { type: _type, error, code, ...details } = await response.json().catch(() => ({})) as { type?: string; error?: string; code?: string };
      throw new HttpError(response.status, error ?? `Owner rejected the request: HTTP ${response.status}`, code, Object.keys(details).length ? details : undefined);
    }
    return response.json();
  }

  /** One of an agent's requests once it settles or `waitMs` passes (`awaitRequest`), wherever the agent is served: here, or on the node that owns it. */
  async function requestAnywhere(agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal): Promise<RequestRecord | undefined> {
    const owner = await clients.ownerElsewhere(agent);
    if (!owner) return clients.awaitRequest(agent, tenant, requestId, waitMs, signal);
    const response = await signedPost(owner, `/internal/agents/${agent}/request`, { tenant, requestId, waitMs }, waitMs + 15_000, signal).catch(error => { ownership.forget(agent); throw error; });
    if (!response.ok) {
      ownership.forget(agent);
      const { error, code } = await response.json().catch(() => ({})) as { error?: string; code?: string };
      throw new HttpError(response.status, error ?? `Owner could not read the request: HTTP ${response.status}`, code);
    }
    return (await response.json() as { record: RequestRecord | null }).record ?? undefined;
  }

  /** Delete an agent wherever it is served: here, or on the node that owns it. */
  async function deleteAnywhere(agent: string, tenant: string) {
    const owner = await clients.ownerElsewhere(agent);
    if (!owner) return clients.destroyAgent(agent, tenant);
    const response = await signedPost(owner, `/internal/agents/${agent}/delete`, { tenant }).catch(error => { ownership.forget(agent); throw error; });
    if (!response.ok) {
      ownership.forget(agent);
      throw new HttpError(response.status, `Owner could not delete the agent: HTTP ${response.status}`);
    }
  }

  /** A page of an agent's history wherever it is served: here, or on the node that owns it, which alone holds its newest turns. */
  async function historyPageAnywhere(agent: string, tenant: string, query: { before?: string; limit?: string }): Promise<HistoryPage> {
    const owner = await clients.ownerElsewhere(agent);
    if (!owner) return clients.historyPageFor(agent, tenant, query);
    const response = await signedPost(owner, `/internal/agents/${agent}/history`, { tenant, query }, 60_000).catch(error => { ownership.forget(agent); throw error; });
    if (!response.ok) {
      ownership.forget(agent);
      const { error } = await response.json().catch(() => ({})) as { error?: string };
      throw new HttpError(response.status, error ?? `Owner could not read the agent's history: HTTP ${response.status}`);
    }
    return response.json() as Promise<HistoryPage>;
  }

  const volumes = new VolumeService({
    db, storage, ownership, idleMs,
    // Volume operations on another node keep their status (and a conflict's current version).
    peer: async (owner, path, payload) => {
      const response = await signedPost(owner, path, payload, 30_000);
      const value = await response.json().catch(() => ({})) as any;
      if (response.ok) return value;
      throw Object.assign(new HttpError(response.status, value.error ?? `Volume owner answered HTTP ${response.status}`), value.current !== undefined ? { current: value.current } : {});
    },
    deliver: submitAnywhere,
    // Uploads, file writes and tool outputs: refused once prepaid credit is spent, and past the tenant's storage limit.
    quota: async tenant => {
      const limit = await accounts.billing.storageLimit(tenant);
      return limit === undefined ? undefined : { limit, used: await storageUsage.tenantUsed(tenant) };
    },
  });

  // Signed file links, under a key derived from the session secret, so every node verifies any node's links.
  const links = new FileLinks(sessionSecret, publicUrl);
  // Where browsers reach the runtime, as browser tokens say: AGENT_PUBLIC_URL unless set; empty for none (a private runtime
  // whose browsers read through the application's proxy).
  const { browserUrl } = config;

  const FORWARDED = "x-agent-runtime-forwarded";
  /** A forwarded request's proof that a peer sent it, which a client cannot forge: `<timestamp>.<signature>`. */
  const HOP = "x-agent-runtime-hop";
  const hopSignature = (timestamp: string, url: string) => internalSignature(timestamp, `hop:${url}`, "");

  /** Whether a peer forwarded this request (and so has counted it against per-address limits). */
  function forwardedByPeer(c: Context) {
    const [timestamp, signature] = (c.req.header(HOP) ?? "").split(".");
    if (!timestamp || !signature || !(Math.abs(Date.now() - Number(timestamp)) <= 60_000)) return false;
    const expected = Buffer.from(hopSignature(timestamp, c.env.incoming.url ?? ""));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Stream a request to the node that owns its actor, and stream the answer back (SSE included). */
  function forward(req: IncomingMessage, res: ServerResponse, owner: string, actor?: string) {
    const target = new URL(req.url ?? "/", owner);
    const via = req.headers[FORWARDED];
    // The host it was sent to goes along, so the owner answers as that origin (origins.of).
    const hop = String(Date.now());
    const headers = { ...req.headers, host: target.host, "x-forwarded-host": req.headers["x-forwarded-host"] ?? req.headers.host, [FORWARDED]: typeof via === "string" ? `${via},${node}` : node, [HOP]: `${hop}.${hopSignature(hop, req.url ?? "/")}` };
    const upstream = network().request(target, { method: req.method, headers }, answer => {
      // The node no longer serves the actor (it moved, or the node is draining): look it up afresh next time.
      if (answer.statusCode === 503) ownership.forget(actor);
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      // Piping does not end the client's response when the owner dies mid-stream; cut it so the client reconnects now.
      answer.on("close", () => { if (!answer.complete) res.destroy(); });
    });
    upstream.on("error", () => {
      ownership.forget(actor);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":"The node serving this agent is unreachable; retry"}'); else res.destroy();
    });
    // An owner that cannot be reached (a partitioned or firewalled address) fails fast instead of hanging until the client gives up.
    upstream.on("socket", socket => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => upstream.destroy(new Error("Connecting to the owner timed out")), 5_000);
      socket.once("connect", () => clearTimeout(timer)).once("close", () => clearTimeout(timer));
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  // Human input waits in Postgres; a tool's opaque request state is sealed when the runtime can seal.
  const inputs = new Inputs({ db, ...(accounts.canStoreKeys ? { sealer: accounts } : {}) });
  const clients = new ClientSessions(supervisor, {
    runEvents: tenant => subscribers.runs(tenant),
    tracing: telemetry,
    // A self-hosted runtime configured by its environment takes keys there too.
    ...(config.selfHostedTenant ? { modelKeyHint: "On this self-hosted runtime, AGENT_TENANT_API_KEYS in its environment sets keys too ({\"anthropic\": \"sk-ant-...\"}; restart it after)." } : {}),
    secret: sessionSecret, toolTimeoutMs, idleMs, streamTimeouts, ...(config.runOverrunMs !== undefined ? { runOverrunMs: config.runOverrunMs } : {}), maxAgentsPerTenant, codeCapacity: config.codeCapacity, ...(config.snapshotBytes !== undefined ? { snapshotBytes: config.snapshotBytes } : {}), orphanSweepMs: orphanMs, childSweepMs: config.childSweepMs, wakesPerHour: config.wakesPerHour, watcherLimitFor: tenant => tenants.maxWatchers(tenant), busyAgents, agentLimitFor: async tenant => {
      // Agents hosted on this node stay within the tenant's busy limit too: its own, or its tier's (else the default).
      const { limit, source } = await accounts.billing.busyLimit(tenant);
      return source === "default" ? undefined : limit;
    },
    apiKeyFor: async (tenant, provider, keyScope) => {
      // A tenant's own endpoint gets identity tokens, and its calls cost the runtime nothing.
      if (Object.hasOwn(tenants.modelEndpoints(tenant) ?? {}, provider)) return { key: IDENTITY_KEY, platform: false };
      // An agent with a key scope, or on the tenant's own provider, resolves its key at each call, so a changed key applies at once.
      if (keyScope || await modelProviders.has(tenant, provider)) return { key: SCOPE_KEY, platform: false };
      const resolved = await accounts.providerKey(tenant, provider);
      // The tenant's own Bedrock key names a region, which each call takes with the key (`scopedKey`).
      if (resolved?.region) return { key: SCOPE_KEY, platform: false };
      return resolved && { key: resolved.key, platform: resolved.source !== "tenant" };
    },
    catalogPriced: async tenant => await accounts.billing.mode(tenant) === "prepaid",
    scopedKey: async (tenant, keyScope, provider) => {
      const entry = keyScope ? await keyScopes.entry(tenant, keyScope, provider) : undefined;
      // The key scope's or the tenant's own provider: the scope's key or address where it gives one, else the provider's; never the platform's.
      const own = await modelProviders.credentials(tenant, provider, keyScope);
      if (own) return { ...own, ...entry, baseUrl: entry?.baseUrl ?? own.baseUrl, apiKey: entry?.apiKey ?? own.apiKey ?? "", platform: false };
      // A scope's entry for a provider that is neither built in nor the tenant's any more (deleted) is nothing to call.
      if (entry && !providerInfo(provider)) return undefined;
      if (entry) return { ...entry, apiKey: entry.apiKey ?? "", platform: false };
      const resolved = await accounts.providerKey(tenant, provider);
      return resolved && { apiKey: resolved.key, platform: resolved.source !== "tenant", ...(resolved.region ? { region: resolved.region } : {}) };
    },
    modelEndpoints: tenant => tenants.modelEndpoints(tenant),
    customProviders: (tenant, keyScope) => modelProviders.resolvable(tenant, keyScope),
    modelToken: (audience, claims) => signer.token(audience, claims),
    onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message),
    transcriber, imager, outbound: outbound.withoutOrigins(),
    onActive: (tenant, agent, ms) => accounts.recordActive(tenant, agent, ms),
    spendLimit: tenant => accounts.runLimit(tenant),
    runLimitsFor: async tenant => {
      const set = await accounts.billing.runLimits(tenant), none = tenants.has(tenant);
      return { maxResponses: set.maxResponses ?? (none ? Infinity : runLimits.maxResponses), maxSeconds: set.maxSeconds ?? (none ? Infinity : runLimits.maxSeconds) };
    },
    codeLimitsFor: tenant => accounts.billing.codeLimits(tenant),
    runRate: tenant => rateLimits.run(tenant),
    rerankers,
    creditLimit: tenant => accounts.billing.creditLimit(tenant),
    db, storage, prefix: "client-sessions/", ownership, volumes, links,
    get scheduler() { return scheduler; },
    // Channels' hooks, and where journey events are on, each run's end (src/journey.ts): the day's activity, and an account's first run.
    get hooks() {
      return !journey ? channels.hooks : { ...channels.hooks, runEnded: (agent, record) => {
        channels.hooks.runEnded?.(agent, record);
        const ending = outcomeEnding(record.outcome);
        void journey.runEnded(agent.tenant, { completed: ending.error === undefined && !ending.stopped, at: record.endedAt });
      } } satisfies SessionHooks;
    },
    definitionFor: async (tenant, id) => {
      const { revision, spec } = await definitions.read(tenant, id);
      const config = sessionConfig({ model: spec.model, systemPrompt: spec.systemPrompt, thinkingLevel: spec.thinkingLevel }, spec.model === undefined ? await defaultModelFor(tenant) : model, systemPrompt, tenants.modelEndpoints(tenant), await modelProviders.resolvable(tenant));
      return { id, revision, ...(spec.description ? { description: spec.description } : {}), config: { model: config.model, systemPrompt: config.systemPrompt, thinkingLevel: config.thinkingLevel ?? "off", fileTools: spec.fileTools !== false, codeMode: spec.codeMode !== false, runLimits: spec.runLimits ?? null, maxOutputTokens: spec.maxOutputTokens ?? null, temperature: spec.temperature ?? null }, sources: sources(spec) };
    },
    sources: toolSources,
    inputs,
    submit: (agent, tenant, request) => submitAnywhere(agent, tenant, request),
    // The delegate builtin's children: agents made as POST /v1/agents makes them, and their requests waited on wherever they run.
    createAgent: (tenant, params, key, parent) => createAgent(tenant, params, key, parent) as Promise<{ id: string }>,
    requestAnywhere: (agent, tenant, requestId, waitMs, signal) => requestAnywhere(agent, tenant, requestId, waitMs, signal),
  });
  // An agent loaded on another node: this node's idle watchers of it end, and reconnect to that node.
  // A tenant's webhook endpoints changed on some node: read them again at its next run.
  const loads = await deps.listen({
    agent_runtime_loaded: payload => {
      const [from, agent] = payload.split(" ");
      if (from !== node && agent) clients.loadedElsewhere(agent);
    },
    [ENDPOINTS_CHANNEL]: tenant => subscribers.forget(tenant),
    [TELEMETRY_CHANNEL]: tenant => telemetry.forget(tenant),
    // Work just left without an owner: a peer released agents with runs open, or ended a dead node's heartbeat.
    [ORPHANS_CHANNEL]: payload => { if (orphanMs && payload.split(" ")[0] !== node) void clients.resumeSoon(); },
  });
  // A dead peer's agents are free: sweep for them here, and tell the other nodes to.
  ownership.onReaped(() => {
    if (!orphanMs) return;
    void clients.resumeSoon();
    void db.query("select pg_notify($1, $2)", [ORPHANS_CHANNEL, node]).catch(() => {});
  });
  // Wake-ups are delivered as prompts with ids derived from the schedule, so repeats are no-ops.
  const scheduler = new Scheduler({
    db, node,
    deliver: async (schedule, requestId) => {
      // Schedules run unattended: without the application, its tools' calls fail as not connected.
      const request = schedule.code !== undefined ? { method: "execute", params: { code: schedule.code, allowDisconnected: true } } : { method: "prompt", params: { text: schedule.text!, allowDisconnected: true } };
      await submitAnywhere(schedule.agent, schedule.tenant, { id: requestId, ...request });
    },
    also: now => clients.expireInputs(now),
  });
  scheduler.start(config.schedulerIntervalMs);
  // Email channels, when the runtime has a domain SES receives for: mail arrives through SNS at one shared route.
  const emailOptions: EmailOptions | undefined = config.email && { db, ...config.email };
  const managedDiscordConfig = await deps.managedDiscord?.();
  const managedDiscord = managedDiscordConfig ? new ManagedDiscord({
    ...managedDiscordConfig, db, consoleAuth, channels: () => channels, ownership, node, publicUrl,
    apiUrl: config.channelApis.discord,
    canStart: tenant => accounts.runLimit(tenant),
    definitionBuiltins: async (tenant, id) => (await definitions.read(tenant, id)).spec.builtins,
    definitionWarnings: async (tenant, id) => warningsFor(tenant, sources((await definitions.read(tenant, id)).spec)),
    // Interim caps until servers have an aggregate budget: free credit gets one server and 500 turns a day per server.
    plan: async tenant => {
      const free = await accounts.billing.onFreeCredit(tenant);
      const servers = tenants.maxDiscordServers(tenant) ?? (free ? config.discordServers.free : config.discordServers.paid);
      return { free, servers, turnsPerDay: free ? 500 : 10_000 };
    },
    applyDefinition: async (tenant, channelId, definitionId) => {
      const definition = await definitions.read(tenant, definitionId);
      const { rows } = await db.query("select ca.agent from channel_agents ca join agents a on a.id = ca.agent where ca.channel = $1 and ca.tenant = $2 and not a.revoked", [channelId, tenant]);
      const requestId = `managed_apply_${randomUUID().replaceAll("-", "")}`;
      const queue = rows.map(({ agent }) => agent as string);
      const results: { agent: string; requestId: string; status: "updated" | "queued" | "failed"; error?: string }[] = [];
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let agent; (agent = queue.shift());) {
          try {
            const record = await submitAnywhere(agent, tenant, { id: requestId, method: "configure", params: { definition: { id: definition.id, revision: definition.revision } } });
            if (record.outcome?.error !== undefined) throw new Error(record.outcome.error);
            results.push({ agent, requestId, status: record.state === "completed" ? "updated" : "queued" });
          } catch (error) { results.push({ agent, requestId, status: "failed", error: errorText(error) }); }
        }
      }));
      return results.sort((a, b) => a.agent.localeCompare(b.agent));
    },
  }) : undefined;
  // Messaging channels: webhooks (or a gateway socket one node holds) in, replies out through a durable queue any node can drain.
  const channels = new Channels({
    db, accounts, definitions, node, publicUrl, ownership,
    providers: {
      telegram: telegram({ apiUrl: config.channelApis.telegram }),
      slack: slack({ apiUrl: config.channelApis.slack }),
      discord: discord({ apiUrl: config.channelApis.discord }),
      ...(managedDiscord ? { "discord-managed": managedDiscord.provider } : {}),
      github: githubChannel({ apiUrl: config.channelApis.github }),
      webhook: webhook({ outbound }),
      ...(emailOptions ? { email: email(emailOptions) } : {}),
    },
    createAgent: (tenant, params, key) => createAgent(tenant, params, key) as Promise<{ id: string }>,
    agentId: (tenant, key) => clients.agentId(tenant, key),
    live: (agent, tenant) => clients.owns(agent, tenant),
    submit: (agent, tenant, request) => submitAnywhere(agent, tenant, request),
    files: {
      upload: (agent, tenant, requestId, name, source, contentType) => clients.uploadFor(agent, tenant, requestId, name, source, contentType),
      ref: (agent, tenant, path) => clients.fileFor(agent, tenant, path),
      read: (tenant, ref) => volumes.stream(tenant, ref),
      link: async (agent, tenant, path) => (await clients.linkFor(agent, tenant, path, FILE_LIMITS.maxLinkSeconds)).url,
    },
    inputs: {
      pending: async agent => (await inputs.pending(agent)).map(inputView),
      answer: (agent, tenant, input, answer) => clients.answer(agent, tenant, [{ id: input, body: answer }], "channel"),
    },
    ...(config.channelRetryMs !== undefined ? { retryBaseMs: config.channelRetryMs } : {}),
  });
  channels.start(config.schedulerIntervalMs);
  void managedDiscord?.start().catch(error => console.error(JSON.stringify({ type: "discord_managed_start_failed", error: safeError(error) })));
  // Accounts being deleted, continued by whichever node claims each (and started at once on a request).
  const accountDeletions = new AccountDeletions({
    db, accounts, storage, volumes, channels, stripe, deleteAgent: deleteAnywhere,
    purgeAgents: () => clients.sweep(), flushStorageUsage: () => storageUsage.flush(),
  });
  accountDeletions.start(config.schedulerIntervalMs);

  const app = new Hono<Env>();
  // The team's admin site, behind Cloudflare Access on a hostname of its own (src/admin-site.ts): answered before anything else.
  const adminSiteOptions = adminSiteFromEnvironment(env, { db, consoleDir, journey: journeySettings && { url: journeySettings.url, secret: journeySettings.secret }, reportSecret: secrets.journeyReportSecret });
  if (adminSiteOptions) app.use(adminSite(adminSiteOptions));
  // On an alias, the pages people use move to the public URL, whose host their sign-in cookies and OAuth callbacks belong to.
  // Everything else (the API, MCP, OAuth's token endpoint, webhooks, links) is served on every origin alike.
  const BROWSER_PAGES = /^\/(?:$|console(?:\/|$)|oauth\/authorize$)/;
  app.use(async (c, next) => {
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || !BROWSER_PAGES.test(c.req.path) || !origins.alias(c.req.raw.headers)) return next();
    const url = new URL(c.req.url);
    return c.redirect(`${origins.canonical}${url.pathname}${url.search}`, 302);
  });
  // The load balancer's health check: failing it while draining stops new requests arriving here. A retiring
  // node stays healthy (ECS replaces tasks that fail it, protected or not) and hands new work to its peers instead.
  // The runtime's public signing keys: tool servers verify its identity tokens with them.
  app.get("/.well-known/jwks.json", async c => c.json(await signer.jwks(), 200, { "Cache-Control": "public, max-age=300" }));
  // ChatGPT's plugin directory checks that whoever submits the plugin controls this host: the token it issues, as plain text.
  const { openAiAppsChallenge } = config;
  app.get("/.well-known/openai-apps-challenge", c => openAiAppsChallenge ? c.text(openAiAppsChallenge, 200, { "Cache-Control": "no-store" }) : c.body(null, 404));
  // OAuth authorization server metadata (RFC 8414), as MCP's authorization spec reads it. It serves two purposes: the
  // issuer of identity tokens and where its keys are, so a tool server that names the runtime in its protected-resource
  // metadata can verify them with standard OAuth tooling; and the endpoints MCP clients of the hosted /mcp sign in
  // with (src/oauth.ts), whose access tokens are opaque and never signed with those keys.
  app.get("/.well-known/oauth-authorization-server", c => c.json({
    issuer: origins.issuer, jwks_uri: `${origins.issuer}/.well-known/jwks.json`, ...oauth.metadata(),
  }, 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  // The public docs (docs/ in the image), for people and for models: cacheable, and readable from any page.
  const docs = loadDocs(config.docsDir, publicUrl);
  // The UI registry's JSON (packages/registry/public/r/ in the image), for `npx shadcn add <runtime>/r/<name>.json`.
  const registry = loadRegistry(config.registryDir, publicUrl);
  // Matched on the request's path as sent, before any decoding or dot-segment folding: only exact document paths answer.
  // /docs itself is for people, who read the docs site. The setup skill is never cached: the one-line prompt that names it
  // stays the same while it changes.
  app.use(async (c, next) => {
    const path = (c.env.incoming.url ?? "").split("?")[0];
    if ((path === "/docs" || path === "/docs/") && (c.req.method === "GET" || c.req.method === "HEAD")) return c.redirect(DOCS_SITE, 302);
    const skill = SKILL_PATHS.includes(path);
    const served = skill || path === "/llms.txt" || path === "/llms-full.txt" || path === "/docs" || path.startsWith("/docs/") ? docs : path === "/r" || path.startsWith("/r/") ? registry : undefined;
    if (!served) return next();
    const doc = c.req.method === "GET" || c.req.method === "HEAD" ? served.get(path) : undefined;
    if (!doc) return c.json({ type: "error", error: `Unknown document. The docs' index: ${origins.canonical}/llms.txt`, code: "NOT_FOUND" }, 404, { "Access-Control-Allow-Origin": "*" });
    return c.body(doc.body, 200, { "Content-Type": doc.type, "Cache-Control": skill ? "no-cache" : "public, max-age=300", "Access-Control-Allow-Origin": "*" });
  });
  app.get("/healthz", c => draining ? c.json({ ok: false, draining: true }, 503) : c.json({ ok: true, ...(retiringSince !== undefined ? { retiring: true } : {}) }));
  // Every 503 is worth retrying (capacity, an actor moving, this node draining), and so is a 429 (a
  // tenant at its agent quota, or an agent with too many queued requests) once work finishes; say when.
  app.use(async (c, next) => {
    await next();
    if (c.res.status === 503 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "1");
    if (c.res.status === 429 && !c.res.headers.has("retry-after")) c.res.headers.set("Retry-After", "5");
  });
  // A browser token's reads, from any origin: the token is what grants them, as with publishable or ephemeral keys.
  // Any node answers the preflight, and the node that serves the read marks it readable (errors too, so the browser
  // sees a 401 and mints a new token). No credentials are allowed, every other route gets no CORS headers, and
  // neither does any request made with the tenant's own tokens.
  const BROWSER_READS = /^\/v1\/agents\/client_[a-f0-9]{40}\/(?:events|state|history|inputs)$/;
  app.use(async (c, next) => {
    if (!c.req.header("origin") || !BROWSER_READS.test(c.req.path)) return next();
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Authorization, Last-Event-ID, Accept", "Access-Control-Max-Age": "86400" });
    }
    if (BrowserTokens.carries(c.req.header("authorization"))) c.env.outgoing.setHeader("Access-Control-Allow-Origin", "*");
    return next();
  });
  /**
   * Whether a request is authenticated as an admin tenant (by its token, a browser token it minted, or a console session):
   * its /v1 traffic is not limited per address. A credential that does not check out is no one's: the API refuses it later.
   */
  async function adminCaller(c: Context) {
    const authorization = c.req.header("authorization");
    let tenant: string | undefined;
    try {
      if (BrowserTokens.carries(authorization)) tenant = browserTokens.verify(authorization!).tenant;
      else tenant = authorization ? (await accounts.authenticate(authorization))?.tenant : (await consoleAuth.principal(c.req.raw))?.tenant;
    } catch { return false; }
    return tenant !== undefined && tenants.has(tenant);
  }
  // Per-address rate limits, on the node a request reaches first (a request a peer forwarded was counted there).
  app.use(async (c, next) => {
    if (!forwardedByPeer(c)) await rateLimits.request(c.req.path, requestClient(c).key, () => adminCaller(c));
    return next();
  });
  // One node serves each agent and volume; anything addressed to one another node holds goes there.
  // Forwarding works on the raw request and response, so bodies and SSE stream through unbuffered.
  // A forwarded request goes no further, but for one that reached a draining node: its sender's cached owner can
  // trail a release by a few seconds, so it goes on once more (to the live owner, or a peer that takes it) instead of a 503.
  app.use(async (c, next) => {
    const via = c.req.header(FORWARDED);
    const target = !via || (ownership.draining && !via.includes(",")) ? await route(c.env.incoming.url).catch(() => undefined) : undefined;
    if (!target) return next();
    forward(c.env.incoming, c.env.outgoing, target.node, target.actor);
    return RESPONSE_ALREADY_SENT;
  });

  app.post("/internal/agents/:id{client_[a-f0-9]{40}}/requests", async c => {
    let body: string | undefined;
    try { body = await signedBody(c); } catch { return c.body(null, 413); }
    if (body === undefined) return c.body(null, 401);
    try {
      const { tenant, request } = JSON.parse(body);
      return c.json(await clients.submit(c.req.param("id"), tenant, request), 202);
    } catch (error) {
      return c.json({ error: errorText(error) }, errorStatus(error, 400) as ContentfulStatusCode);
    }
  });
  app.post("/internal/agents/:id{client_[a-f0-9]{40}}/request", async c => {
    let body: string | undefined;
    try { body = await signedBody(c); } catch { return c.body(null, 413); }
    if (body === undefined) return c.body(null, 401);
    try {
      const { tenant, requestId, waitMs } = JSON.parse(body);
      // The asking node's connection closing ends the wait.
      const closed = new AbortController();
      c.env.outgoing.once("close", () => closed.abort());
      return c.json({ record: await clients.awaitRequest(c.req.param("id"), tenant, String(requestId), Number(waitMs) || 0, closed.signal) ?? null });
    } catch (error) {
      return c.json({ error: errorText(error), code: errorCode(error, errorStatus(error, 400)) }, errorStatus(error, 400) as ContentfulStatusCode);
    }
  });
  app.post("/internal/agents/:id{client_[a-f0-9]{40}}/delete", async c => {
    let body: string | undefined;
    try { body = await signedBody(c); } catch { return c.body(null, 413); }
    if (body === undefined) return c.body(null, 401);
    try {
      await clients.destroyAgent(c.req.param("id"), JSON.parse(body).tenant);
      return c.body(null, 204);
    } catch (error) {
      return c.json({ error: errorText(error) }, errorStatus(error, 400) as ContentfulStatusCode);
    }
  });
  app.post("/internal/agents/:id{client_[a-f0-9]{40}}/history", async c => {
    let body: string | undefined;
    try { body = await signedBody(c); } catch { return c.body(null, 413); }
    if (body === undefined) return c.body(null, 401);
    try {
      const { tenant, query } = JSON.parse(body);
      return c.json(await clients.historyPageFor(c.req.param("id"), tenant, query));
    } catch (error) {
      return c.json({ error: errorText(error) }, errorStatus(error, 400) as ContentfulStatusCode);
    }
  });
  app.post("/internal/volumes/:id{vol_[a-f0-9]{24}}/ops", async c => {
    let body: string | undefined;
    try { body = await signedBody(c); } catch { return c.body(null, 413); }
    if (body === undefined) return c.body(null, 401);
    try {
      const { tenant, op, args } = JSON.parse(body);
      return c.json(await volumes.handle(c.req.param("id"), tenant, op, args));
    } catch (error) {
      return c.json({ error: errorText(error), ...(error instanceof VersionConflict ? { current: error.current } : {}) }, errorStatus(error, 400) as ContentfulStatusCode);
    }
  });
  app.all("/internal/*", c => c.body(null, 404));
  app.route("/", consoleAuth.app);
  if (managedDiscord) app.route("/", managedDiscord.app);
  else app.get("/console/discord/config", c => c.json({ enabled: false }, 200, { "Cache-Control": "no-store" }));
  app.route("/", oauth.app);
  // The hosted MCP endpoints: their tools call this node's REST API locally, as the caller.
  const { loopbackHost } = config;
  const mcpOptions = {
    authenticate: async (authorization: string | undefined) => await accounts.authenticate(authorization) ?? await oauth.authenticate(authorization),
    origins,
    loopback: () => `http://${loopbackHost}:${(server.address() as { port: number }).port}`,
  };
  app.route("/", hostedMcp(mcpOptions));
  // Each agent as an MCP server of its own: one tool that messages it. Before api, whose /v1/agents/:id/* it is in.
  app.route("/", agentMcp({ ...mcpOptions, agents: clients, definitions }));
  // Before channels.app, whose /channels/:type/:id would take /channels/email/inbound.
  if (emailOptions) app.route("/", emailReceiver(channels, emailOptions));
  app.route("/", channels.app);
  // Browser tokens: HMACs under a key derived from the session secret, so any node checks any node's.
  const browserTokens = new BrowserTokens(sessionSecret);
  if (billingMailer) app.route("/", billingMailer.feedback());
  // A transcription or images asked for alone count as a run: refused past a monthly cap, spent credit or runs per minute.
  const admitAlone = async (tenant: string) => {
    const refused = await accounts.runLimit(tenant);
    if (refused) throw typeof refused === "string" ? new HttpError(402, refused, "SPEND_LIMIT") : refused;
    await rateLimits.run(tenant);
  };
  app.route("/", api({ accounts, journey, billingAlerts: { service: billingAlerts, emailEnabled: !!billingMailer }, help, clients, consoleAuth, oauth, createAgent, modelProviders, defaultModel: async tenant => { const chosen = await defaultModelFor(tenant); return `${chosen.provider}/${chosen.id}`; }, keyScopes, webhooks, telemetry, scheduler, accountDeletions, ...(config.idempotencyLockMs !== undefined ? { idempotencyLockMs: config.idempotencyLockMs } : {}), channels, volumes, definitions, links, fileUrls, browserTokens, get browserUrl() { return browserUrl === undefined ? links.publicUrl : browserUrl || undefined; }, submit: submitAnywhere, historyPage: historyPageAnywhere, verifyKeys: config.verifyKeys,
    rateLimits, clientAddress: c => requestClient(c).address, runRetentionSeconds, requestAnywhere,
    transcriptions: {
      transcriber, outbound: outbound.withoutOrigins(),
      admit: admitAlone,
      record: (tenant, usage) => accounts.recordUsage(tenant, "", usage),
    },
    images: {
      imager, outbound: outbound.withoutOrigins(),
      admit: admitAlone,
      record: (tenant, usage) => accounts.recordUsage(tenant, "", usage),
      owns: (tenant, volume) => volumes.owns(volume, tenant),
      save: async (tenant, volume, path, bytes, contentType) => {
        const { chunks: _chunks, ...entry } = await volumes.put(tenant, volume, path, bytes, { contentType, by: "images" });
        return entry;
      },
    },
    runPrecheck: async tenant => { await rateLimits.runsLeft(tenant); const refused = await busyAgents.check(tenant); if (refused) throw refused; },
    createRun: (tenant, params, key, run) => createAgent(tenant, params, key, undefined, undefined, run) as Promise<{ id: string; existing?: boolean }>,
    billingAdmins: config.billingAdmins }));
  if (journey) app.route("/", journeyApp(journey, consoleAuth, c => requestClient(c).key));
  // The query goes along: a link from the operator's site says in it where the visitor came from (src/journey.ts).
  app.get("/console", c => c.redirect(`/console/${new URL(c.req.url).search}`, 302));
  app.get("/console/*", serveConsole);
  app.get("/", c => c.redirect(`/console/${new URL(c.req.url).search}`, 302));
  app.route("/", clients.app);

  // Everything below is for operator tokens, and never for browsers.
  // (`/registry/*` matches `/registry` too.)
  app.use("/registry/*", async (c, next) => {
    const principal = await accounts.authenticate(c.req.header("authorization"));
    if (!principal) return c.json({ type: "error", error: signInHint(origins.canonical), code: "UNAUTHORIZED" }, 401);
    if (c.req.header("origin")) return c.body(null, 403);
    c.set("tenant", principal.tenant);
    await next();
  });
  app.get("/registry", async c => c.json(await clients.list(c.var.tenant)));
  const registered = "/registry/:id{client_[a-f0-9]{40}}";
  app.get(registered, async c => c.json(await clients.inspect(c.req.param("id"), c.var.tenant)));
  // The operator bridge: the client routes accept requests to the operator's own agents without their token.
  app.post(`${registered}/requests`, c => clients.app.request(`/clients/${c.req.param("id")}/requests`,
    { method: "POST", headers: c.req.raw.headers, body: c.req.raw.body, duplex: "half" } as RequestInit, { ...c.env, operatorTenant: c.var.tenant }));
  for (const path of [registered, `${registered}/requests`]) app.all(path, c => c.body(null, 405));
  // Anything else is no route at all: say so, and where to start, to whoever guessed the path (often a coding agent).
  app.notFound(c => c.json({ type: "error", error: `Not found. The docs' index: ${origins.canonical}/llms.txt; coding agents setting camelRun up: ${origins.canonical}/SKILL.md`, code: "NOT_FOUND" }, 404));
  // Errors keep their own status (429 quota, 409 conflict, 410 revoked, 503 retry...); an unreachable database is 503, and
  // anything else is a request the runtime could not accept (invalid configuration or tools): 400.
  app.onError((error, c) => {
    const status = errorStatus(error, 400);
    return c.body(JSON.stringify({ type: "error", error: errorText(error), code: errorCode(error, status), ...errorFields(error) }) + "\n", status as ContentfulStatusCode, { "Content-Type": "application/json", ...errorHeaders(error) });
  });

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  // A request has 30 s to arrive whole, except an upload, which streams to storage a chunk at a time
  // and may take FILE_LIMITS.uploadMs. Node's requestTimeout is one value for every request, so it is off.
  server.requestTimeout = 0;
  const UPLOAD = /^\/(?:v1\/volumes\/vol_[a-f0-9]{24}\/files\/|v1\/links\/|v1\/agents\/client_[a-f0-9]{40}\/uploads\/|clients\/client_[a-f0-9]{40}\/(?:files|uploads)\/)/;
  server.on("request", (req: IncomingMessage) => {
    const timer = setTimeout(() => { if (!req.complete) req.socket.destroy(); }, req.method === "PUT" && UPLOAD.test(req.url ?? "") ? FILE_LIMITS.uploadMs : 30_000);
    timer.unref();
    req.once("close", () => clearTimeout(timer));
  });
  const start = () => new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      // Without AGENT_PUBLIC_URL the issuer is where this node listens: known only now when PORT is 0.
      if (!config.publicUrlSet) signer.issuer = links.publicUrl = origins.canonical = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      console.log(JSON.stringify({ type: "listening", address: server.address(), node, tenants: tenants.source, hosting, storage: deps.storage ? "given" : storageDescriptor.kind, github: github ? (github.open ? "open" : "org") : false, google: !!google, accountEmail: accountMailSettings?.provider ?? false, keyStorage: accounts.canStoreKeys, sandbox, toolSearch: rerankers.length ? rerankers.map(stage => stage.kind).join(",") : "keyword", stripe: stripe ? (stripe.live ? "live" : "test") : false }));
      resolve(server.address() as AddressInfo);
    });
    // As soon as it listens, as before: whether a newer deployment replaced this task (ECS only).
    void watchRetirement();
  });
  // A bad tenants file or secret is rejected whole; the tenants loaded before stay in force.
  const reloadTenants = (announce: boolean) => tenants.reload().then(
    () => { if (announce) console.log(JSON.stringify({ type: "tenants_reloaded" })); },
    error => console.error(JSON.stringify({ type: "tenants_reload_failed", error: errorText(error) })));
  // Tasks on ECS get no SIGHUP: re-read the secret every minute so tenant changes land without a deploy.
  const tenantsTimer = tenants.source === "secret" ? setInterval(() => void reloadTenants(false), 60_000) : undefined;
  tenantsTimer?.unref();

  // Load for autoscaling, as a CloudWatch metric extracted from the log line.
  const loadTimer = setInterval(() => {
    const memory = process.memoryUsage();
    console.log(nodeLoadLine({
      hostedAgents: supervisor.agents.size, sessions: clients.sessions.size, volumes: volumes.size, runningTurns: clients.inFlight(), rssBytes: memory.rss,
      watchers: clients.watchers, dbConnections: db.totalCount, dbIdle: db.idleCount, dbWaiting: db.waitingCount,
      heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers,
    }, config.serviceName, { node, retiring: retiringSince !== undefined }));
    // Every node reports the shared outboxes' backlog: read it with Maximum.
    void webhooks.backlog().then(backlog => console.log(webhookBacklogLine(backlog)))
      .catch(error => console.error(JSON.stringify({ type: "webhook_backlog_failed", error: errorText(error) })));
  }, 60_000);
  loadTimer.unref();
  // Tail rows a dead node left for agents and volumes that are gone since.
  const sweepTimer = setInterval(() => void sweepTails(db).catch(error => console.error(JSON.stringify({ type: "tail_sweep_failed", error: errorText(error) }))), 60 * 60_000);
  sweepTimer.unref();
  // Deleted and expired agents' data, purged by whichever nodes get to it first.
  const purgeTimer = setInterval(() => void clients.sweep(), config.purgeMs);
  purgeTimer.unref();
  // Chunks nothing refers to any more, and deleted volumes' objects, collected a tenant at a time by whichever node is free.
  // Off unless AGENT_GC_ENABLED; with AGENT_GC_DRY_RUN it only logs what it would delete. What it needs (pins, which chunks
  // writes created) is recorded either way, so turning it on later loses nothing.
  const storageGc = new StorageGc({ db, storage, volumes, graceMs: config.gc.graceMs, intervalMs: config.gc.intervalMs, dryRun: config.gc.dryRun });
  if (config.gc.enabled) storageGc.start(config.gc.pollMs);
  // Agents no node holds with work left (a dead owner's turn, runs a drain queued) are loaded by whichever node gets to them first,
  // so their runs resume even when no one reads them. A node sweeps as it starts too: in a deploy, its peers are retiring and do not.
  const orphanTimer = orphanMs ? setInterval(() => void clients.resumeSoon(), orphanMs) : undefined;
  orphanTimer?.unref();
  if (orphanMs) void clients.resumeSoon();
  // Sub-agents' endings whose delivery to their parent a lost node left undone, delivered by whichever node gets to them first.
  const childTimer = config.childSweepMs ? setInterval(() => void clients.sweepChildren(), config.childSweepMs) : undefined;
  childTimer?.unref();
  // Storage is charged to prepaid tenants once a UTC day, by whichever node claims the day's job first.
  const { billingMs, reconcileDays } = config;
  // The charge reads tracked totals; a full listing of Storage corrects them every AGENT_STORAGE_RECONCILE_DAYS (0: never, but for the first).
  const chargeStorage = () => void accounts.billing.chargeStorage(storage, storageUsage, node, { reconcileDays }).catch(error => console.error(JSON.stringify({ type: "storage_charge_failed", error: errorText(error) })));
  const billingTimer = setInterval(chargeStorage, billingMs);
  billingTimer.unref();
  const firstCharge = setTimeout(chargeStorage, Math.min(billingMs, 60_000));
  firstCharge.unref();

  /**
   * Deploys and scale-in on ECS. While a turn runs the task is protected, so ECS
   * stops idle tasks instead. A task a newer deployment superseded retires once that
   * deployment runs all its tasks (or AGENT_RETIRE_WAIT_MS has passed) and a peer
   * that is not retiring has joined: it takes nothing new (its peers do), and each running
   * turn finishes only the step it is in (its model call, or its latest response's tool
   * calls), then is handed off to a peer at that boundary, which continues it at once
   * (`handOffTurns`). Idle agents (one waiting on human input, say), queued runs and
   * volumes move as soon as they are idle. A step still running AGENT_RETIRE_MAX_MS after
   * the retirement began is handed off mid-step. With nothing left the task drops its
   * protection, so ECS stops it and the SIGTERM drain is empty. A retiring task left with
   * no such peer serves again until one joins: refusing work would leave it nowhere to go.
   */
  const protection = new TaskProtection({ uri: config.ecs.agentUri, idleMs: config.ecs.protectionIdleMs });
  let retiringSince: number | undefined;
  let retired = false;
  let pausing = false;
  let cutOff = false;
  const workTimer = setInterval(() => {
    if (retiringSince !== undefined && !cutOff && Date.now() - retiringSince > retireMaxMs) {
      cutOff = true;
      console.log(JSON.stringify({ type: "retire_cap_reached", node, ms: Date.now() - retiringSince, inFlight: clients.inFlight() }));
      void clients.handOffAll().catch(error => console.error(JSON.stringify({ type: "retire_handoff_failed", error: safeError(error) })));
    }
    if (retiringSince !== undefined) {
      void clients.releaseIdle().then(() => volumes.releaseIdle()).catch(error => console.error(JSON.stringify({ type: "retire_release_failed", error: errorText(error) })));
      if (!retired && !clients.inFlight() && !clients.sessions.size && !volumes.size) {
        retired = true;
        console.log(JSON.stringify({ type: "retired", node, ms: Date.now() - retiringSince }));
      }
      if (!pausing) {
        pausing = true;
        void ownership.peer().then(async peer => {
          if (peer || retiringSince === undefined || draining) return;
          console.log(JSON.stringify({ type: "retire_paused", node, ms: Date.now() - retiringSince }));
          retiringSince = undefined;
          retired = false;
          cutOff = false;
          clients.handOffTurns(undefined);
          clients.draining = false;
          await ownership.undrain();
        }).catch(error => console.error(JSON.stringify({ type: "retire_pause_failed", error: errorText(error) }))).finally(() => { pausing = false; });
      }
    }
    const capped = retiringSince !== undefined && Date.now() - retiringSince > retireMaxMs;
    void protection.update(clients.inFlight() > 0 && !capped);
  }, 1_000);
  workTimer.unref();
  let retireTimer: ReturnType<typeof setInterval> | undefined;
  async function watchRetirement() {
    const superseded = await deps.supersession?.().catch(error => { console.error(JSON.stringify({ type: "ecs_service_unavailable", error: errorText(error) })); return undefined; });
    if (!superseded || draining) return;
    retireTimer = setInterval(() => void superseded().then(async state => {
      if (state !== "superseded" || retiringSince !== undefined || draining || !await ownership.peer()) return;
      retiringSince = Date.now();
      console.log(JSON.stringify({ type: "retiring", node, inFlight: clients.inFlight(), agents: clients.sessions.size, volumes: volumes.size }));
      clients.draining = true;
      clients.handOffTurns("retire");
      await ownership.drain();
    }).catch(error => console.error(JSON.stringify({ type: "ecs_service_check_failed", error: errorText(error) }))), config.ecs.pollMs);
    retireTimer.unref();
  }

  /**
   * Leave the cluster without dropping work. ECS deregisters the task from the load
   * balancer, sends SIGTERM, and SIGKILLs after the task's stopTimeout. /healthz fails
   * at once and this node takes no new agents or volumes: requests for ones it does
   * not hold go to a live peer, or get 503 and Retry-After. With a live peer, each running
   * turn finishes only the step it is in and is handed off at that boundary; alone, turns
   * finish. Either way it waits for up to AGENT_DRAIN_TIMEOUT_MS; runs that never began
   * stay queued for the next owner. Then everything is released (a step still running is
   * cut off, its calls in flight unknown), and only then are event streams closed, so
   * clients reconnect to the next owner. A second signal (`drain` again, or `close`) stops waiting.
   */
  let drainDeadline = 0;
  let draining: Promise<void> | undefined;
  async function drain(signal: string) {
    const started = Date.now();
    console.log(JSON.stringify({ type: "drain_started", signal, node, inFlight: clients.inFlight(), agents: clients.sessions.size, volumes: volumes.size }));
    scheduler.stop();
    channels.stop();
    await managedDiscord?.stop();
    webhooks.stop();
    accountDeletions.stop();
    storageGc.stop();
    rateLimits.stop();
    clearInterval(nodesTimer);
    clearInterval(tenantsTimer);
    clearInterval(loadTimer);
    clearInterval(sweepTimer);
    clearInterval(purgeTimer);
    clearInterval(orphanTimer);
    clearInterval(childTimer);
    clearInterval(billingTimer);
    clearInterval(workTimer);
    if (retireTimer) clearInterval(retireTimer);
    clients.draining = true;
    let failed = false;
    const step = async (name: string, work: () => Promise<unknown>) => {
      try { await work(); }
      catch (error) { failed = true; console.error(JSON.stringify({ type: "drain_step_failed", step: name, error: errorText(error) })); }
    };
    await step("drain", () => ownership.drain());
    // With a peer to continue them, running turns are handed off at their next step boundary, and idle agents (one waiting
    // on human input, say) move at once. Alone, the node lets its turns finish instead: nobody could go on with them now.
    await step("hand-off", async () => { if (await ownership.peer()) clients.handOffTurns("drain"); });
    // A second signal may come at any moment, and the node stops waiting for its turns.
    if (buggify("drain.stop_waiting")) drainDeadline = 0;
    for (let tick = 0; clients.inFlight() && Date.now() < drainDeadline; tick++) {
      if (tick % 10 === 0) void clients.releaseIdle().catch(error => console.error(JSON.stringify({ type: "drain_release_failed", error: safeError(error) })));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const unfinished = clients.inFlight();
    sometimes(unfinished > 0, "a drain released turns still running");
    await step("agents", () => clients.close());
    // The spans of the runs this node served or handed off, sent within a few seconds.
    await step("telemetry", () => telemetry.close());
    await step("supervisor", () => supervisor.close());
    await step("volumes", () => volumes.close());
    await step("mcp", () => mcp.close());
    await step("usage", () => accounts.flushUsage());
    await step("auto top-up", async () => { await accounts.billing.autoTopup?.stop(); });
    await step("billing email", async () => { await billingMailer?.stop(); supportMail?.destroy(); await accountMail?.stop(); });
    await step("storage usage", () => storageUsage.flush());
    await step("listen", () => loads.close());
    await step("heartbeat", () => ownership.close());
    server.close();
    server.closeAllConnections();
    // What else the node started, which a process that exits now would end anyway.
    journey?.stop();
    clearInterval(idempotencyTimer);
    clearTimeout(firstCharge);
    deps.codeExecutor?.close?.();
    await step("database", () => db.end());
    console.log(JSON.stringify({ type: "drain_finished", node, ms: Date.now() - started, unfinished }));
    if (failed) throw new Error("Drain finished with errors");
  }
  const leave = (signal: string, waitMs: number) => {
    if (draining) { drainDeadline = 0; return draining; }
    drainDeadline = Date.now() + waitMs;
    return draining = drain(signal);
  };

  return {
    node, app, server, start,
    reloadTenants: () => reloadTenants(true),
    run: work => work(),
    drain: (signal = "drain") => leave(signal, config.drainMs),
    close: () => leave("close", 0),
  };
}
