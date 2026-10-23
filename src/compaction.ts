import { attemptStream, type UsageSink } from "./model-attempt-stream.ts";
import type { CreditStop, ModelAttemptHook } from "./model-attempt.ts";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { getProviders, streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { estimateContextTokens, estimateTokens } from "./pi-harness/tokens.ts";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fileChars as charsOf, validFileRef } from "./files.ts";
import type { Credentials } from "./protocol.ts";
import { AZURE_CHAT_API_VERSION } from "./azure-openai.ts";
import { guardedModelFetch, guardedNodeAgents, outboundOfProcess, type Outbound } from "./outbound.ts";
import { reasoningFloor, withOpenRouterHosts } from "./pi-catalog.ts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { streamTimeouts, watchedStream, type Stall, type StreamTimeouts } from "./model-stream.ts";
import { network } from "./node-context.ts";
import { MODEL_INTERRUPTED } from "./model-errors.ts";
import { deepseekContext, deepseekTarget } from "./deepseek-replay.ts";

/**
 * Model calls as the runtime makes them (`explicitKeyStream`: the tenant's key or per-call credentials, never the
 * environment's; its node's lease and outbound policy; attempt accounting), and the token estimate of a context.
 * Pi durable compacts natively; the compactor that lived here went with the legacy engine.
 */

/**
 * Tokens the context will cost: the provider's last usage report plus an estimate for
 * later messages, or pi's per-message estimate if larger. Providers that report no
 * usage (some proxies) would otherwise look empty and never compact. Pi counts nothing
 * for file references, so what each stands for is added (see `fileChars`). `fixedTokens`, what
 * every request carries besides messages (the system prompt), counts toward the estimate only: a
 * provider's report already includes it.
 */
export function contextTokens(messages: AgentMessage[], fixedTokens = 0): number {
  let estimated = 0;
  const files = messages.map(message => Math.ceil(fileChars(message) / 4));
  messages.forEach((message, index) => { estimated += estimateTokens(message) + files[index]; });
  // A response from before the summary was written reported the context it replaced: its usage says nothing now.
  const since = messages.find(message => message.role === "compactionSummary")?.timestamp ?? -Infinity;
  const reported = estimateContextTokens(messages.map(message => message.role === "assistant" && message.timestamp < since ? { ...message, usage: undefined as never } : message));
  const trailing = files.slice((reported.lastUsageIndex ?? -1) + 1).reduce((sum, tokens) => sum + tokens, 0);
  return Math.max(reported.tokens + trailing, estimated + fixedTokens);
}

/** Characters the file references in a user message or tool result stand for. */
function fileChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.reduce((sum: number, block) => sum + (validFileRef(block) ? charsOf(block) : 0), 0) : 0;
}

/** Where a call to a tenant's own endpoint carries its identity token, besides where the provider takes its key. */
export const IDENTITY_HEADER = "X-Agent-Runtime-Identity";

/**
 * A model on a tenant's own endpoint as Pi calls it: `chiridion` / `openrouter/anthropic/claude-sonnet-5`
 * becomes `openrouter` / `anthropic/claude-sonnet-5`, so Pi speaks that provider's protocol, and the
 * responses (and their signatures, which Pi keeps only for the same provider and model) are its.
 * Bedrock's region, already in the model's baseUrl, leaves the id.
 */
function upstream(model: Model<Api>): Model<Api> {
  const [provider, ...rest] = model.id.split("/");
  if (provider === "amazon-bedrock") rest.shift();
  return { ...model, provider, id: rest.join("/") };
}
/** Match the response's accounting name, including its tenant endpoint prefix. */
function attemptModel(model: Model<Api>, credentials: Credentials): Model<Api> {
  if (!credentials.identity) return model;
  const target = upstream(model);
  return { ...target, provider: `${model.provider}/${target.provider}` };
}
/** Pi's options for a call to a tenant's own endpoint: its token also as `IDENTITY_HEADER`, and Bedrock over HTTP/1.1, as any gateway takes it. */
const identityOptions = (model: Model<Api>, options: any, token: string) =>
  ({ ...options, apiKey: token, headers: { ...options?.headers, [IDENTITY_HEADER]: token }, env: { AWS_BEDROCK_FORCE_HTTP1: "1" }, ...(model.api === "openai-codex-responses" ? codexOptions(token) : {}) });

/**
 * Pi's Codex client reads the `chatgpt-account-id` header from the key, a ChatGPT token, and fails
 * without that claim. For a tenant's endpoint it decodes a key whose account is a placeholder the
 * endpoint replaces, and the identity token goes back in as the bearer when the request is sent.
 * Over SSE, not the WebSocket Pi tries first, and without its retries (none by default).
 */
const CODEX_KEY = ["{}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "passthrough" } }), "passthrough"].map(part => Buffer.from(part).toString("base64")).join(".");
const codexOptions = (token: string) => ({
  apiKey: CODEX_KEY, transport: "sse", maxRetries: 0,
  fetch: (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return network().fetch(url, { ...init, headers });
  },
});

/**
 * Pi's other clients make one attempt per call and leave retries to the runtime (none for a
 * tenant's own endpoint, which retries itself); its Bedrock client keeps the AWS SDK's three
 * attempts, so each Bedrock request is made a single attempt too.
 */
const noRetries = { acquireInitialRetryToken: async () => ({ getRetryCount: () => 0, getRetryDelay: () => 0 }), refreshRetryTokenForRetry: async () => { throw new Error("No retries"); }, recordSuccess: () => {} };
const send = BedrockRuntimeClient.prototype.send;
/** Bedrock's own regional endpoint: never a gateway. */
const AWS_BEDROCK = /^bedrock-runtime(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com$/;
/**
 * Hosts of gateways tenants gave for Bedrock (key scopes' baseUrl), as `authorize` meets them, with the outbound policy of
 * the node that met them; an operator's endpoint is not one.
 */
const tenantGateways = new Map<string, Outbound>();
const guarded = new WeakSet<BedrockRuntimeClient>();
BedrockRuntimeClient.prototype.send = async function (this: BedrockRuntimeClient, ...args: unknown[]) {
  (this.config as { retryStrategy: unknown }).retryStrategy = async () => noRetries;
  // A gateway's address is called through the outbound guard, as every URL a tenant gives is: the client takes no fetch,
  // so its connections go through agents whose lookup checks each address it connects to (HTTP/1.1, as for gateways).
  const endpoint = await (this.config as { endpoint?: () => Promise<{ protocol: string; hostname: string; port?: number }> }).endpoint?.();
  const gateway = endpoint && tenantGateways.get(endpoint.hostname);
  if (endpoint && gateway && !AWS_BEDROCK.test(endpoint.hostname) && !guarded.has(this)) {
    const url = `${endpoint.protocol}//${endpoint.hostname.includes(":") ? `[${endpoint.hostname}]` : endpoint.hostname}${endpoint.port ? `:${endpoint.port}` : ""}/`;
    (this.config as { requestHandler: unknown }).requestHandler = new NodeHttpHandler(guardedNodeAgents(url, gateway));
    guarded.add(this);
  }
  return (send as (...args: unknown[]) => unknown).apply(this, args);
} as typeof send;

/** APIs whose clients take the runtime's fetch, so it can read their cost, move their endpoint, and drop auth headers. Google's, for one, takes none. */
export const FETCH_APIS = ["openai-completions", "openai-responses", "anthropic-messages"];
/**
 * What a key scope's `baseUrl` stands for: the provider's API root as gateways in front of it name
 * it (Cloudflare AI Gateway's `/openrouter`, `/anthropic`, `/openai`), else the model's own base URL.
 */
export const PROVIDER_ROOTS: Record<string, string> = { openrouter: "https://openrouter.ai/api/v1", anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" };

/**
 * The fetch a call makes: its URL moved from `rebase.from` (the longest that matches) to `rebase.to`,
 * without the provider's auth headers when `keyless`, and reading the cost the provider reports in
 * the response's usage as the body streams past: OpenRouter's `usage.cost` (plus the upstream cost
 * of a key brought to OpenRouter), which Pi does not keep. `sink.cost` has it once the body is read.
 */
export function callFetch(sink: UsageSink, plan: { rebase?: { from: string[]; to: string }; keyless?: boolean; bearer?: string; base?: typeof fetch } = {}): typeof fetch {
  const read = async (line: string) => {
    if (!line.startsWith("data:") && !line.startsWith("{")) return;
    let data: any;
    try { data = JSON.parse(line.startsWith("data:") ? line.slice(5) : line); } catch { return; }
    {
      const generation = data?.id ?? data?.response?.id ?? data?.message?.id;
      if (typeof generation === "string") await sink.generation?.(generation);
      // The host OpenRouter routed the call to: its chunks' `provider`, or an error's `metadata.provider_name`.
      const host = data?.provider ?? data?.response?.provider ?? data?.error?.metadata?.provider_name;
      if (typeof host === "string" && /^[\w .()/-]{1,60}$/.test(host)) sink.host = host;
      const usage = data?.usage ?? data?.response?.usage ?? data?.message?.usage;
      if (typeof usage?.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return;
      const upstream = usage.is_byok ? Number(usage.cost_details?.upstream_inference_cost) : 0;
      sink.credits = usage.cost;
      sink.cost = usage.cost + (Number.isFinite(upstream) && upstream > 0 ? upstream : 0);
    }
  };
  return async (input, init) => {
    let url = String(input);
    if (plan.rebase) {
      const from = plan.rebase.from.find(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
      if (!from) throw new Error(`The key scope's baseUrl does not stand for ${new URL(url).origin}`);
      url = plan.rebase.to + url.slice(from.length);
    }
    let headers = init?.headers;
    if (plan.keyless) {
      const without = new Headers(headers);
      for (const name of ["authorization", "x-api-key"]) without.delete(name);
      headers = without;
    } else if (plan.bearer) {
      const bearer = new Headers(headers);
      bearer.delete("x-api-key");
      bearer.set("authorization", `Bearer ${plan.bearer}`);
      headers = bearer;
    }
    const response = await (plan.base ?? network().fetch)(url, { ...init, headers });
    // Messages API bodies carry Anthropic msg_* IDs; OpenRouter's lookup ID is in this header.
    // Persist it before exposing any response bytes, including empty/error responses.
    const generation = response.headers.get("x-generation-id");
    if (generation) {
      try { await sink.generation?.(generation); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    }
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop()!;
        for (const line of lines) await read(line.trim());
        controller.enqueue(chunk);
      },
      async flush() { await read(pending.trim()); },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Pi's model and options for one call with `credentials`, reading the provider's cost into `sink`.
 * Headers are Pi's, then a key scope entry's, then the agent's own `modelHeaders` (never auth headers).
 * A key scope's `baseUrl` replaces the provider's root (`PROVIDER_ROOTS`) in each request's URL, or for
 * an API that takes no fetch (Bedrock, Google), the model's base URL. An entry without a key sends none.
 */
function authorize(model: Model<Api>, asked: any, credentials: Credentials, sink: UsageSink, modelHeaders: Record<string, string> | null | undefined, outbound: Outbound): [Model<Api>, any] {
  // A DeepSeek model on OpenRouter is called on Chat Completions, where its history's reasoning goes back (deepseek-replay.ts).
  model = deepseekTarget(model);
  // A model that always reasons refuses a call that turns reasoning off: a call asking for none asks for its least.
  const floor = asked?.reasoning ? undefined : reasoningFloor(model);
  const { dataCollection, ...rest } = (floor ? { ...asked, reasoning: floor } : asked) ?? {};
  // An OpenRouter call takes its model's hosts (pi-catalog.ts OPENROUTER_HOSTS) and its agent's data policy
  // (`dataCollection`), nothing else of routing.
  const options = model.provider === "openrouter"
    ? { ...rest, onPayload: async (payload: unknown, at: Model<Api>) => withOpenRouterHosts(at, (await rest.onPayload?.(payload, at)) ?? payload, dataCollection) }
    : rest;
  if (credentials.identity) {
    const target = upstream(model);
    const callOptions = identityOptions(model, { ...options, headers: { ...options?.headers, ...modelHeaders } }, credentials.apiKey);
    return [target, callOptions.fetch || !FETCH_APIS.includes(target.api) ? callOptions : { ...callOptions, fetch: callFetch(sink) }];
  }
  const { apiKey, baseUrl, headers, region, bearer } = credentials;
  if (model.provider === "azure" || model.api === "azure-openai-responses") return [model, azureOptions(model, options, credentials, modelHeaders, sink)];
  const fetchable = FETCH_APIS.includes(model.api);
  if (!apiKey && !fetchable) throw new Error(`A key scope entry without an apiKey cannot call ${model.provider}'s ${model.api} API`);
  const bedrock = model.api === "bedrock-converse-stream";
  const callOptions = {
    // A bearer credential must not reach Pi's sk-ant-oat substring detection: that path adds
    // Claude Code subscription headers, tool renaming and a system prompt. callFetch installs the real token.
    ...options, apiKey: bearer && model.api === "anthropic-messages" ? "runtime-bearer" : apiKey || "keyless", headers: { ...options?.headers, ...headers, ...modelHeaders },
    // Bedrock's region reaches Pi's client only through `env` (its simple options drop a `region`), ahead of the
    // process's AWS_REGION. Bedrock through a gateway speaks HTTP/1.1, as its pass-through does.
    env: bedrock ? { ...(region ? { AWS_REGION: region } : {}), ...(baseUrl ? { AWS_BEDROCK_FORCE_HTTP1: "1" } : {}) } : {},
  };
  if (!fetchable && baseUrl) tenantGateways.set(new URL(baseUrl).hostname, outbound);
  if (!fetchable) return [baseUrl ? { ...model, baseUrl } : model, callOptions];
  const from = [Object.hasOwn(PROVIDER_ROOTS, model.provider) ? PROVIDER_ROOTS[model.provider] : undefined, model.baseUrl]
    .filter((prefix): prefix is string => !!prefix).map(prefix => prefix.replace(/\/+$/, "")).sort((a, b) => b.length - a.length);
  // An endpoint the tenant gave is called through the outbound guard, as every URL a tenant gives is: a key scope's
  // baseUrl, and whatever a model not of Pi's providers (a tenant's own provider's) was made with.
  const tenantGiven = !!baseUrl || !getProviders().includes(model.provider as never);
  return [model, { ...callOptions, fetch: callFetch(sink, { ...(baseUrl ? { rebase: { from, to: baseUrl } } : {}), ...(tenantGiven ? { base: guardedModelFetch(outbound) } : {}), keyless: !apiKey, ...(bearer && apiKey ? { bearer: apiKey } : {}) }) }];
}

/**
 * A call to the platform's Azure OpenAI resource (azure-openai.ts): Pi's Azure client, told the v1 API root, its version
 * and the model's deployment through its call's `env`, which it reads before the process's (so no AZURE_OPENAI_* of the
 * host's applies), over the node's network as every model call is. A model the resource has no deployment of is refused
 * before any request.
 */
function azureOptions(model: Model<Api>, options: any, credentials: Credentials, modelHeaders: Record<string, string> | null | undefined, sink: UsageSink) {
  // Deployments are of Responses API models only (azure-openai.ts): Azure's others (DeepSeek on its completions API) have none.
  const deployment = model.api === "azure-openai-responses" && credentials.deployments && Object.hasOwn(credentials.deployments, model.id) ? credentials.deployments[model.id] : undefined;
  if (!credentials.baseUrl || !deployment) throw new Error(`No azure deployment is configured for ${model.provider}/${model.id} on this runtime; move the agent to a model you can use (GET /v1/models?available=true)`);
  return {
    ...options, apiKey: credentials.apiKey, headers: { ...options?.headers, ...modelHeaders }, fetch: callFetch(sink),
    env: { AZURE_OPENAI_BASE_URL: credentials.baseUrl, AZURE_OPENAI_API_VERSION: AZURE_CHAT_API_VERSION, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=${deployment}` },
  };
}

/**
 * The only way this runtime calls a model: with the tenant's explicit key. Pi-ai
 * falls back to provider keys in the process environment whenever no key is passed
 * (an `env` option only overrides those, it never hides them), which in a shared
 * worker could serve one tenant with another's (or the host's) key. When `perCall()`
 * gives credentials, the call uses them: an identity token for the tenant's own
 * endpoint, or a key scope's current entry. `modelHeaders()` are the agent's own headers.
 */
/**
 * Why a run's model call failed, when the remedy is the caller's: no key for the model (`model_key_missing`), or a key
 * the provider refused (`model_key_invalid`, with what to do before the provider's own words). Anything else: undefined.
 */
export function modelKeyFailure(error: string, model: { provider: string; id: string }): { code: "model_key_missing" | "model_key_invalid"; error: string } | undefined {
  if (/^No \S+ (?:API key|deployment) is configured for /.test(error)) return { code: "model_key_missing", error };
  if (/^401\b/.test(error)) return { code: "model_key_invalid", error: `${model.provider} refused the API key for ${model.provider}/${model.id} (401): set a working one with PUT /v1/providers/${model.provider}/key (or the key scope's entry), or move the agent to a model you can use (GET /v1/models?available=true). ${model.provider} said: ${error}` };
  return undefined;
}

/**
 * How a node's lease (`Ownership.fresh`) bounds its model requests: each waits for `wait` before it starts, and is in
 * `open` while it runs, so the host can cut them all when the lease goes stale (`interrupt`).
 */
export interface ModelGate { wait(signal?: AbortSignal): Promise<void>; open: Set<AbortController> }

/** A signal for one model request that `gate` can cut, registered in `gate.open` until `done`. */
function gatedSignal(gate: ModelGate | undefined, signal: AbortSignal | undefined) {
  if (!gate) return { signal, cut: undefined, done: () => {} };
  const cut = new AbortController();
  gate.open.add(cut);
  return { signal: signal ? AbortSignal.any([signal, cut.signal]) : cut.signal, cut, done: () => { gate.open.delete(cut); } };
}

/** `outbound` is the policy calls to endpoints tenants give go through: this process's unless given (its node's). */
export function explicitKeyStream(perCall?: () => Promise<Credentials> | undefined, modelHeaders?: () => Record<string, string> | null | undefined, gate?: ModelGate,
  timeouts?: (model: Model<Api>, reasoning: string | undefined) => StreamTimeouts, onStall?: (stall: Stall) => void, outbound: Outbound = outboundOfProcess(), attempt?: ModelAttemptHook,
  onRefused?: (stop: CreditStop) => void): StreamFn {
  return (model, context, options) => {
    if (!options?.apiKey?.trim()) throw new Error(`No ${model.provider} API key is configured for this agent's model, ${model.provider}/${model.id}; set one with PUT /v1/providers/${model.provider}/key, or move the agent to a model you can use (GET /v1/models?available=true)`);
    const apiKey = options.apiKey;
    // A provider's stream that goes quiet is ended (model-stream.ts), and so is one the turn's abort or the lease reaches, at once.
    const limits = timeouts?.(model, options.reasoning ?? reasoningFloor(model)) ?? streamTimeouts(model, options.reasoning ?? reasoningFloor(model));
    // What the request's context comes to, as the host estimates it: its end user's hold, and the input billed for a request cut short.
    const input = () => Math.min(model.contextWindow, context.messages.reduce((sum, message) => sum + (message.role === "system"
      ? Math.ceil(JSON.stringify(message).length / 4) : estimateTokens(message)), 0));
    // The prefix the previous response read from or wrote to the provider's cache is likely read from it now, at its rate.
    const previous = context.messages.findLast(message => message.role === "assistant")?.usage;
    const inputTokens = input(), cachedTokens = Math.min(inputTokens, (previous?.cacheRead ?? 0) + (previous?.cacheWrite ?? 0));
    const estimate = { inputTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}), maxOutputTokens: options.maxTokens ?? model.maxTokens, rates: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead } };
    const call = (credentials: Credentials) => attemptStream(attemptModel(model, credentials), credentials.apiKey, "response", attempt, (sink, halt) => {
      const { signal, cut, done } = gatedSignal(gate, options.signal ? AbortSignal.any([options.signal, halt]) : halt);
      let requested = false;
      return watchedStream(model, (watched, activity) => {
        const [target, callOptions] = authorize(model, options, credentials, sink, modelHeaders?.(), outbound);
        const observe = callOptions.onProviderStreamEvent;
        requested = true;
        const stream = streamSimple(target, deepseekContext(target, context), { ...callOptions, signal: watched, onProviderStreamEvent: (event: unknown, at: Model<Api>) => { activity(event); return observe?.(event, at); } });
        // The finished message carries the provider's own cost, when it reported one, as `usage.providerCost`.
        const push = stream.push.bind(stream);
        stream.push = event => {
          if (event.type === "done" && sink.cost !== undefined) Object.assign(event.message.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
          if ((event.type === "done" || event.type === "error") && sink.host) Object.assign((event.type === "done" ? event.message : event.error).usage, { providerHost: sink.host });
          push(event);
        };
        return stream;
      }, limits, signal, onStall, event => {
        done();
        // Cut by the lease, not by the run: a failure the turn retries once the lease is fresh, not an abort that ends it.
        if (event.type === "error" && cut?.signal.aborted && !options.signal?.aborted) return { type: "error", reason: "error", error: { ...event.error, stopReason: "error", errorMessage: MODEL_INTERRUPTED } };
        if (requested && event.type === "error" && event.reason === "aborted") {
          // OpenAI-style streams usually report input usage only at the end. Keep a server-side estimate of
          // the actual context, including tools, so canceling cannot make a large prompt free.
          Object.assign(event.error.usage, { estimatedInputTokens: estimate.inputTokens });
        }
        return event;
      });
    }, estimate, onRefused, !!credentials.baseUrl);
    const start = () => {
      const credentials = perCall?.();
      return credentials ? credentials.then(call) : call({ apiKey });
    };
    return gate ? gate.wait(options.signal).then(start) : start();
  };
}

