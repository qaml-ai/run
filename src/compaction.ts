import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { getProviders, streamSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { compact, estimateContextTokens, estimateTokens, generateSummary, prepareCompaction, shouldCompact, type CompactionSettings, type Complete } from "./pi-harness/compaction.ts";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionState } from "./transcript.ts";
import { messageChars } from "./history.ts";
import { fileChars as charsOf, validFileRef } from "./files.ts";
import type { Credentials } from "./protocol.ts";
import { guardedModelFetch, guardedNodeAgents, outboundOfProcess, type Outbound } from "./outbound.ts";
import { reasoningFloor } from "./pi-catalog.ts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { streamTimeouts, watchedStream, type Stall, type StreamTimeouts } from "./model-stream.ts";
import { network } from "./node-context.ts";

/**
 * Context compaction on top of Pi's compaction functions (vendored from pi-agent-core 0.87.1 in
 * pi-harness/, as Pi 1.0 dropped them). Pi picks the
 * cut (never splitting a tool call from its result, summarizing a split turn's
 * prefix separately) and writes a structured summary that updates the previous
 * one. This module decides when to compact, adapts our flat working set to pi's
 * session entries, and summarizes oversized histories in chunks.
 */

/** Scale pi's defaults (16k reserve, 20k kept) down for small context windows. */
export function compactionSettings(model: Model<Api>): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: Math.min(16_384, Math.floor(model.contextWindow * 0.15)),
    keepRecentTokens: Math.min(20_000, Math.floor(model.contextWindow * 0.25)),
  };
}

/** Working sets above this many characters compact even if tokens look fine (image-heavy histories). */
export const MAX_WORKING_CHARS = 12_000_000;

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

/** Pi's per-message estimate of `messages`' tokens, file references included: unlike `contextTokens`, for any part of a context. */
export function messagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message) + Math.ceil(fileChars(message) / 4), 0);
}

/** Characters the file references in a user message or tool result stand for. */
function fileChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.reduce((sum: number, block) => sum + (validFileRef(block) ? charsOf(block) : 0), 0) : 0;
}

/**
 * How far below the blocking threshold background compaction starts: pi-durable's 32k tokens, scaled
 * down for small context windows like the reserve. Enough room for a few turns while the summary is made.
 */
export function backgroundTokens(model: Model<Api>): number {
  return Math.min(32_768, Math.floor(model.contextWindow * 0.15));
}

/**
 * Whether the context needs compacting before its next request (`blocking`: it would not fit, past the
 * window less the reserve or MAX_WORKING_CHARS), may compact in the background while requests go on
 * (`background`: within `backgroundTokens` of that), or neither. `fixedTokens` covers what every request
 * carries besides messages, such as the system prompt.
 */
export function compactionNeed(messages: AgentMessage[], model: Model<Api>, fixedTokens = 0): "blocking" | "background" | undefined {
  const settings = compactionSettings(model);
  const tokens = contextTokens(messages, fixedTokens);
  if (shouldCompact(tokens, model.contextWindow, settings)) return "blocking";
  let chars = 0;
  for (const message of messages) if ((chars += messageChars(message)) > MAX_WORKING_CHARS) return "blocking";
  return shouldCompact(tokens, model.contextWindow, { ...settings, reserveTokens: settings.reserveTokens + backgroundTokens(model) }) ? "background" : undefined;
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
function callFetch(sink: { cost?: number; credits?: number }, plan: { rebase?: { from: string[]; to: string }; keyless?: boolean; bearer?: string; base?: typeof fetch } = {}): typeof fetch {
  const read = (line: string) => {
    if (!line.startsWith("data:") && !line.startsWith("{") || !line.includes('"cost"')) return;
    try {
      const data = JSON.parse(line.startsWith("data:") ? line.slice(5) : line);
      const usage = data?.usage ?? data?.response?.usage ?? data?.message?.usage;
      if (typeof usage?.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return;
      const upstream = usage.is_byok ? Number(usage.cost_details?.upstream_inference_cost) : 0;
      sink.credits = usage.cost;
      sink.cost = usage.cost + (Number.isFinite(upstream) && upstream > 0 ? upstream : 0);
    } catch { /* not JSON */ }
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
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop()!;
        for (const line of lines) read(line.trim());
      },
      flush() { read(pending.trim()); },
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
function authorize(model: Model<Api>, asked: any, credentials: Credentials, sink: { cost?: number; credits?: number }, modelHeaders: Record<string, string> | null | undefined, outbound: Outbound): [Model<Api>, any] {
  // A model that always reasons refuses a call that turns reasoning off: a call asking for none asks for its least.
  const floor = asked?.reasoning ? undefined : reasoningFloor(model);
  const options = floor ? { ...asked, reasoning: floor } : asked;
  if (credentials.identity) {
    const target = upstream(model);
    const callOptions = identityOptions(model, { ...options, headers: { ...options?.headers, ...modelHeaders } }, credentials.apiKey);
    return [target, callOptions.fetch || !FETCH_APIS.includes(target.api) ? callOptions : { ...callOptions, fetch: callFetch(sink) }];
  }
  const { apiKey, baseUrl, headers, region, bearer } = credentials;
  const fetchable = FETCH_APIS.includes(model.api);
  if (!apiKey && !fetchable) throw new Error(`A key scope entry without an apiKey cannot call ${model.provider}'s ${model.api} API`);
  const bedrock = model.api === "bedrock-converse-stream";
  const callOptions = {
    ...options, apiKey: apiKey || "keyless", headers: { ...options?.headers, ...headers, ...modelHeaders },
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
  if (/^No \S+ API key is configured for /.test(error)) return { code: "model_key_missing", error };
  if (/^401\b/.test(error)) return { code: "model_key_invalid", error: `${model.provider} refused the API key for ${model.provider}/${model.id} (401): set a working one with PUT /v1/providers/${model.provider}/key (or the key scope's entry), or move the agent to a model you can use (GET /v1/models?available=true). ${model.provider} said: ${error}` };
  return undefined;
}

/**
 * How a node's lease (`Ownership.fresh`) bounds its model requests: each waits for `wait` before it starts, and is in
 * `open` while it runs, so the host can cut them all when the lease goes stale (`interrupt`).
 */
export interface ModelGate { wait(signal?: AbortSignal): Promise<void>; open: Set<AbortController> }
/** Why a model request was cut by its node's stale lease. Retryable (a lost connection): it is made again once the lease is fresh, or by the agent's next owner. */
export const MODEL_INTERRUPTED = "Model request interrupted: this node's connection to its cluster was lost; it is made again once the node's lease is renewed";

/** A signal for one model request that `gate` can cut, registered in `gate.open` until `done`. */
function gatedSignal(gate: ModelGate | undefined, signal: AbortSignal | undefined) {
  if (!gate) return { signal, cut: undefined, done: () => {} };
  const cut = new AbortController();
  gate.open.add(cut);
  return { signal: signal ? AbortSignal.any([signal, cut.signal]) : cut.signal, cut, done: () => { gate.open.delete(cut); } };
}

/** `outbound` is the policy calls to endpoints tenants give go through: this process's unless given (its node's). */
export function explicitKeyStream(perCall?: () => Promise<Credentials> | undefined, modelHeaders?: () => Record<string, string> | null | undefined, gate?: ModelGate,
  timeouts?: (model: Model<Api>, reasoning: string | undefined) => StreamTimeouts, onStall?: (stall: Stall) => void, outbound: Outbound = outboundOfProcess()): StreamFn {
  return (model, context, options) => {
    if (!options?.apiKey?.trim()) throw new Error(`No ${model.provider} API key is configured for this agent's model, ${model.provider}/${model.id}; set one with PUT /v1/providers/${model.provider}/key, or move the agent to a model you can use (GET /v1/models?available=true)`);
    const apiKey = options.apiKey;
    // A provider's stream that goes quiet is ended (model-stream.ts), and so is one the turn's abort or the lease reaches, at once.
    const limits = timeouts?.(model, options.reasoning ?? reasoningFloor(model)) ?? streamTimeouts(model, options.reasoning ?? reasoningFloor(model));
    const call = (credentials: Credentials) => {
      const { signal, cut, done } = gatedSignal(gate, options.signal);
      return watchedStream(model, (watched, activity) => {
        const sink: { cost?: number; credits?: number } = {};
        const [target, callOptions] = authorize(model, options, credentials, sink, modelHeaders?.(), outbound);
        const observe = callOptions.onProviderStreamEvent;
        const stream = streamSimple(target, context, { ...callOptions, signal: watched, onProviderStreamEvent: (event: unknown, at: Model<Api>) => { activity(event); return observe?.(event, at); } });
        // The finished message carries the provider's own cost, when it reported one, as `usage.providerCost`.
        const push = stream.push.bind(stream);
        stream.push = event => {
          if (event.type === "done" && sink.cost !== undefined) Object.assign(event.message.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
          push(event);
        };
        return stream;
      }, limits, signal, onStall, event => {
        done();
        // Cut by the lease, not by the run: a failure the turn retries once the lease is fresh, not an abort that ends it.
        if (event.type === "error" && cut?.signal.aborted && !options.signal?.aborted) return { type: "error", reason: "error", error: { ...event.error, stopReason: "error", errorMessage: MODEL_INTERRUPTED } };
        return event;
      });
    };
    const start = () => {
      const credentials = perCall?.();
      return credentials ? credentials.then(call) : call({ apiKey });
    };
    return gate ? gate.wait(options.signal).then(start) : start();
  };
}

/**
 * Pi's summarizer only needs a completion; bind the tenant's key (or per-call credentials:
 * a fresh identity token for its own endpoint, a key scope's entry) and never the environment.
 * Every completed request is reported, so chunks and a run that fails after some are billed too.
 */
type ApiKey = string | (() => Promise<Credentials>);
function summarizer(apiKey: ApiKey, onResponse: ((message: AssistantMessage) => void) | undefined, modelHeaders: Record<string, string> | null | undefined, gate: ModelGate | undefined, outbound: Outbound): Complete {
  return async (model, context, options) => {
    const sink: { cost?: number; credits?: number } = {};
    await gate?.wait(options?.signal);
    const { signal, done } = gatedSignal(gate, options?.signal);
    let response: AssistantMessage;
    try {
      const [target, callOptions] = authorize(model, options, typeof apiKey === "string" ? { apiKey } : await apiKey(), sink, modelHeaders, outbound);
      // Watched like a turn's requests: a summary whose stream goes quiet fails (the context is left as it is) rather than hold the turn.
      response = await watchedStream(model, (watched, activity) => streamSimple(target, context, { ...callOptions, signal: watched, onProviderStreamEvent: (event: unknown) => activity(event) }),
        streamTimeouts(model, callOptions?.reasoning), signal).result();
    } finally { done(); }
    if (sink.cost !== undefined) Object.assign(response.usage, { providerCost: sink.cost, providerCreditCost: sink.credits });
    if (response.stopReason !== "error") onResponse?.(response);
    return response;
  };
}

/**
 * Our working set as pi session entries. The previous summary retains nothing itself:
 * the working set is exactly what follows it, so entry ids stay absolute indexes.
 */
function entries(context: AgentMessage[], offset: number, previous?: CompactionState) {
  const list: any[] = [];
  let parentId: string | null = null;
  if (previous) {
    list.push({ type: "compaction", id: "previous", parentId, seq: 0, timestamp: previous.at, summary: previous.summary, retainedTail: [], tokensBefore: previous.tokensBefore, details: previous.details, fromHook: false });
    parentId = "previous";
  }
  context.forEach((message, index) => {
    const id = String(offset + index);
    list.push({ type: "message", id, parentId, seq: offset + index + 1, timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(), message });
    parentId = id;
  });
  return list;
}

export type CompactionOutcome = { state: CompactionState } | { skipped: string };

/**
 * Summarize everything before a cut that keeps recent context. Histories too large
 * for one summarization request (e.g. a big imported conversation) are folded in
 * chunks, each summary feeding the next as the "previous summary".
 */
export async function runCompaction(options: {
  context: AgentMessage[]; offset: number; previous?: CompactionState;
  model: Model<Api>; apiKey: ApiKey; signal?: AbortSignal;
  /** Keep less than usual, e.g. after the provider rejected the context as too long. */
  keepRecentTokens?: number;
  /** Each summarization response the provider completed, for billing. */
  onResponse?: (message: AssistantMessage) => void;
  /** The agent's own headers for its model calls. */
  modelHeaders?: Record<string, string> | null;
  /** Its node's lease, which each summarization request waits for and is cut by (`ModelGate`). */
  gate?: ModelGate;
  /** The policy calls to endpoints tenants give go through: this process's unless given (its node's). */
  outbound?: Outbound;
}): Promise<CompactionOutcome> {
  const { context, offset, previous, model, apiKey, signal } = options;
  const defaults = compactionSettings(model);
  const settings = options.keepRecentTokens ? { ...defaults, keepRecentTokens: Math.min(defaults.keepRecentTokens, options.keepRecentTokens) } : defaults;
  const prepared = prepareCompaction(entries(context, offset, previous) as never, settings);
  if (!prepared.ok) throw prepared.error;
  const preparation = prepared.value;
  // A cut that keeps everything would only add a summary of nothing, and change the cached prefix for it.
  if (!preparation || (!preparation.messagesToSummarize.length && !preparation.turnPrefixMessages.length)) return { skipped: "Nothing before the recent context to summarize" };
  const complete = summarizer(apiKey, options.onResponse, options.modelHeaders, options.gate, options.outbound ?? outboundOfProcess());
  // Leave room for the summarization prompt and the summary itself.
  const chunkBudget = Math.max(4_000, Math.floor((model.contextWindow - settings.reserveTokens) * 0.6));
  let tokens = 0;
  let chunkStart = 0;
  for (let index = 0; index < preparation.messagesToSummarize.length; index++) {
    tokens += estimateTokens(preparation.messagesToSummarize[index]);
    if (tokens <= chunkBudget || index === chunkStart) continue;
    const summary = await generateSummary(preparation.messagesToSummarize.slice(chunkStart, index), complete, { model, reserveTokens: settings.reserveTokens, previousSummary: preparation.previousSummary }, signal);
    if (!summary.ok) throw summary.error;
    preparation.previousSummary = summary.value.text;
    chunkStart = index;
    tokens = estimateTokens(preparation.messagesToSummarize[index]);
  }
  preparation.messagesToSummarize = preparation.messagesToSummarize.slice(chunkStart);
  const result = await compact(preparation, complete, { model }, signal);
  if (!result.ok) throw result.error;
  // Pi returns the kept messages themselves; they are the working set's tail.
  const kept = result.value.retainedTail;
  const cut = offset + context.length - kept.length;
  if (cut < offset || kept.some((message, index) => message !== context[cut - offset + index])) throw new Error("Compaction kept messages that are not the working set's tail");
  return { state: { summary: result.value.summary, cut, tokensBefore: result.value.tokensBefore, details: result.value.details, at: Date.now() } };
}
