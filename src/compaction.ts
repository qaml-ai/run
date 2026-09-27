import {
  BACKGROUND_CONTEXT, compact, estimateContextTokens, estimateTokens, generateSummary, prepareCompaction, shouldCompact, withAbortSignal,
  type AgentMessage, type CompactionSettings, type StreamFn,
} from "@earendil-works/pi-agent-core";
import { completeSimple, streamSimple, type Api, type Model, type Models } from "@earendil-works/pi-ai/compat";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionState } from "./transcript.ts";
import { messageChars } from "./history.ts";
import { fileChars as charsOf, validFileRef } from "./files.ts";
import type { Credentials } from "./protocol.ts";

/**
 * Context compaction on top of pi-agent-core's compaction functions. Pi picks the
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
 * for file references, so what each stands for is added (see `fileChars`).
 */
export function contextTokens(messages: AgentMessage[]): number {
  let estimated = 0;
  const files = messages.map(message => Math.ceil(fileChars(message) / 4));
  messages.forEach((message, index) => { estimated += estimateTokens(message) + files[index]; });
  const reported = estimateContextTokens(messages);
  const trailing = files.slice((reported.lastUsageIndex ?? -1) + 1).reduce((sum, tokens) => sum + tokens, 0);
  return Math.max(reported.tokens + trailing, estimated);
}

/** Characters the file references in a user message or tool result stand for. */
function fileChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content.reduce((sum: number, block) => sum + (validFileRef(block) ? charsOf(block) : 0), 0) : 0;
}

/** `fixedTokens` covers what every request carries besides messages, such as the system prompt. */
export function needsCompaction(messages: AgentMessage[], model: Model<Api>, fixedTokens = 0): boolean {
  const settings = compactionSettings(model);
  if (shouldCompact(contextTokens(messages) + fixedTokens, model.contextWindow, settings)) return true;
  let chars = 0;
  for (const message of messages) if ((chars += messageChars(message)) > MAX_WORKING_CHARS) return true;
  return false;
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
    return fetch(url, { ...init, headers });
  },
});

/**
 * Pi's other clients make one attempt per call and leave retries to the runtime (none for a
 * tenant's own endpoint, which retries itself); its Bedrock client keeps the AWS SDK's three
 * attempts, so each Bedrock request is made a single attempt too.
 */
const noRetries = { acquireInitialRetryToken: async () => ({ getRetryCount: () => 0, getRetryDelay: () => 0 }), refreshRetryTokenForRetry: async () => { throw new Error("No retries"); }, recordSuccess: () => {} };
const send = BedrockRuntimeClient.prototype.send;
BedrockRuntimeClient.prototype.send = function (this: BedrockRuntimeClient, ...args: unknown[]) {
  (this.config as { retryStrategy: unknown }).retryStrategy = async () => noRetries;
  return (send as (...args: unknown[]) => unknown).apply(this, args);
} as typeof send;

/** Pi's model and options for one call with `credentials`. */
function authorize(model: Model<Api>, options: any, credentials: Credentials): [Model<Api>, any] {
  if (credentials.identity) return [upstream(model), identityOptions(model, options, credentials.apiKey)];
  const { apiKey, baseUrl, headers, region } = credentials;
  // Bedrock through a gateway speaks HTTP/1.1, as its pass-through does.
  const env = model.api === "bedrock-converse-stream" && baseUrl ? { AWS_BEDROCK_FORCE_HTTP1: "1" } : {};
  return [baseUrl ? { ...model, baseUrl } : model, { ...options, apiKey, env, ...(headers ? { headers: { ...options?.headers, ...headers } } : {}), ...(region ? { region } : {}) }];
}

/**
 * The only way this runtime calls a model: with the tenant's explicit key. Pi-ai
 * falls back to provider keys in the process environment whenever no key is passed
 * (an `env` option only overrides those, it never hides them), which in a shared
 * worker could serve one tenant with another's (or the host's) key. When `perCall()`
 * gives credentials, the call uses them: an identity token for the tenant's own
 * endpoint, or a key scope's current entry.
 */
export function explicitKeyStream(perCall?: () => Promise<Credentials> | undefined): StreamFn {
  return (model, context, options) => {
    if (!options?.apiKey?.trim()) throw new Error(`No ${model.provider} API key is configured for this agent`);
    const call = (credentials: Credentials) => {
      const [target, callOptions] = authorize(model, options, credentials);
      return streamSimple(target, context, callOptions);
    };
    const credentials = perCall?.();
    return credentials ? credentials.then(call) : call({ apiKey: options.apiKey });
  };
}

/**
 * Pi's summarizer only needs `completeSimple`; bind the tenant's key (or per-call credentials:
 * a fresh identity token for its own endpoint, a key scope's entry) and never the environment.
 * Every completed request is reported, so chunks and a run that fails after some are billed too.
 */
type ApiKey = string | (() => Promise<Credentials>);
function summarizer(apiKey: ApiKey, onResponse?: (message: AssistantMessage) => void): Models {
  return {
    completeSimple: async (model: Model<Api>, context: any, options: any) => {
      const [target, callOptions] = authorize(model, options, typeof apiKey === "string" ? { apiKey } : await apiKey());
      const response = await completeSimple(target, context, callOptions);
      if (response.stopReason !== "error") onResponse?.(response);
      return response;
    },
  } as unknown as Models;
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
}): Promise<CompactionOutcome> {
  const { context, offset, previous, model, apiKey, signal } = options;
  const defaults = compactionSettings(model);
  const settings = options.keepRecentTokens ? { ...defaults, keepRecentTokens: Math.min(defaults.keepRecentTokens, options.keepRecentTokens) } : defaults;
  const prepared = prepareCompaction(entries(context, offset, previous) as never, settings);
  if (!prepared.ok) throw prepared.error;
  const preparation = prepared.value;
  if (!preparation) return { skipped: "Nothing before the recent context to summarize" };
  const models = summarizer(apiKey, options.onResponse);
  const scope = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  // Leave room for the summarization prompt and the summary itself.
  const chunkBudget = Math.max(4_000, Math.floor((model.contextWindow - settings.reserveTokens) * 0.6));
  let tokens = 0;
  let chunkStart = 0;
  for (let index = 0; index < preparation.messagesToSummarize.length; index++) {
    tokens += estimateTokens(preparation.messagesToSummarize[index]);
    if (tokens <= chunkBudget || index === chunkStart) continue;
    const summary = await generateSummary(preparation.messagesToSummarize.slice(chunkStart, index), models, model, settings.reserveTokens, undefined, preparation.previousSummary, undefined, undefined, undefined, scope);
    if (!summary.ok) throw summary.error;
    preparation.previousSummary = summary.value;
    chunkStart = index;
    tokens = estimateTokens(preparation.messagesToSummarize[index]);
  }
  preparation.messagesToSummarize = preparation.messagesToSummarize.slice(chunkStart);
  const result = await compact(preparation, models, model, undefined, undefined, undefined, undefined, scope);
  if (!result.ok) throw result.error;
  // Pi returns the kept messages themselves; they are the working set's tail.
  const kept = result.value.retainedTail;
  const cut = offset + context.length - kept.length;
  if (cut < offset || kept.some((message, index) => message !== context[cut - offset + index])) throw new Error("Compaction kept messages that are not the working set's tail");
  return { state: { summary: result.value.summary, cut, tokensBefore: result.value.tokensBefore, details: result.value.details, at: Date.now() } };
}
