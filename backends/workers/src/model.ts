import "./model-bedrock.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import {
  stream as streamOpenAI,
  streamSimple as streamOpenAISimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { withImageReferences, type ImageBindings } from "./images.ts";
import { withAttachmentReferences } from "./prompt-attachments.ts";
import type { FileBindings } from "./files.ts";
import { createAI } from "agents/models/pi-ai";

import { stream as streamResponses, streamSimple as simpleResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as streamAnthropic, streamSimple as simpleAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle, streamSimple as simpleGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamBedrock, streamSimple as simpleBedrock } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as streamCodex, streamSimple as simpleCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamAzure, streamSimple as simpleAzure } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { getModels, getModel, callSettings, withOpenRouterHosts, reasoningFloor } from "./model-catalog.ts";
import { resolveModel, virtualChain, routeModel, virtualModelReferences, type ModelEndpoints, type CustomProviders } from "./model-policy.ts";
import { deepseekContext, refusedReasoningReplay } from "./deepseek-policy.ts";
import { OutputRequest } from "./output-request.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { boundedModel } from "./model-context.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { modelOutbound } from "./security-outbound.ts";
import { gatewayUrl } from "./model-gateway.ts";
import { FETCH_APIS } from "./model-call-fetch.ts";
import { listModels } from "./catalog-policy.ts";
import { streamTimeouts, watchedStream, isStalled, type Stall } from "./model-stream.ts";
import { runtimeStreamTimeouts, type ModelTimeoutEnv } from "./model-runtime-options.ts";
import { PREPARED_MODEL_CREDENTIALS } from "./model-request-auth.ts";
import { modelCallKind } from "./model-call-context.ts";
import { contentFilterFallbacks } from "./default-model-policy.ts";
import { isContentFilterBlock, isModelUnavailable } from "./model-errors.ts";
import { ModelReplayRetry, type ModelRetryEvent } from "./model-replay-retry.ts";
import { missingModelKey } from "./selfhost-policy.ts";

export type ModelRequestSettings = AgentConfiguration & { requestId?: string; outputReminded?: boolean; output?: { schema?: Record<string, unknown>; [key: string]: unknown } };
export type ModelCredentials = { apiKey?: string; baseUrl?: string; headers?: Record<string, string>; region?: string; bearer?: true; identity?: true; deployments?: Record<string, string> };
export type ModelHooks = {
  agentId?: () => Promise<string>;
  beforeRequest?: () => Promise<void>;
  onStreamEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
  onDiscardedOutput?: (message: AssistantMessage) => void | Promise<void>;
  onRetryEvent?: (event: ModelRetryEvent) => void | Promise<void>;
  onStall?: (stall: Stall & { provider: string; model: string }) => void | Promise<void>;
  wrapProvider?: (provider: Provider) => Provider;
  settings?: () => Promise<ModelRequestSettings>;
  credentials?: (provider: string) => Promise<ModelCredentials | undefined>;
  endpoints?: ModelEndpoints;
  customProviders?: CustomProviders;
};

function withSettings(provider: Provider, hooks: ModelHooks, env: ModelTimeoutEnv & { TEST_MODE?: string; TEST_MODEL?: string; AGENT_CONTENT_FILTER_FALLBACKS?: string; AGENT_TENANT?: string }): Provider {
  const timeouts = runtimeStreamTimeouts(env);
  let routing: { user: string; previous?: Model<Api>; failed?: Model<Api> } | undefined;
  const outputRequest = new OutputRequest();
  const replayRetry = new ModelReplayRetry(hooks.onRetryEvent);
  const filterFallbacks = contentFilterFallbacks(env.AGENT_CONTENT_FILTER_FALLBACKS);
  const prepare = async (model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
    const callKind = modelCallKind(context);
    await hooks.beforeRequest?.();
    const config = await hooks.settings?.() ?? {};
    if (config.model?.startsWith("camelrun/")) {
      const user = config.requestId ?? String([...context.messages].reverse().find(message => message.role === "user")?.timestamp ?? 0);
      if (!routing || routing.user !== user) routing = { user };
      const selected = routeModel(resolveModel(config.model), { reason: routing.failed ? "retry" : routing.previous ? "continuation" : "user", failed: routing.failed, previous: routing.previous });
      if (!selected) throw new Error("Virtual model fallback chain is exhausted");
      model = { ...boundedModel(selected, config.runLimits?.contextTokens), ...(env.TEST_MODEL === "1" ? { baseUrl: model.baseUrl, api: model.api, runtimeApi: selected.api } : {}) };
    }
    const credential = await hooks.credentials?.(model.provider);
    if (credential?.baseUrl) {
      const catalog = getModel(model.provider, model.id);
      model = { ...model, api: (model as Model<Api> & { runtimeApi?: Api }).runtimeApi ?? catalog?.api ?? model.api };
      if (FETCH_APIS.includes(model.api) && catalog) model = { ...model, baseUrl: catalog.baseUrl };
    }
    let fallback = filterFallbacks.get(`${model.provider}/${model.id}`);
    if (fallback && (credential?.identity || credential?.baseUrl && !credential.deployments || !(await hooks.credentials?.(fallback.provider))?.apiKey)) fallback = undefined;
    const virtualNext = config.model?.startsWith("camelrun/") ? routeModel(resolveModel(config.model), { reason: "retry", failed: model }) : undefined;
    const structured = callKind === "compaction" ? { context, toolChoice: undefined } : outputRequest.prepare(model, context, config);
    const { toolChoice } = structured;
    context = structured.context;
    const deployment = credential?.deployments?.[model.id];
    if (model.provider === "azure" && !credential?.identity && (!credential?.baseUrl || !deployment))
      throw new Error(`No azure deployment is configured for ${model.provider}/${model.id} on this runtime; move the agent to a model you can use (GET /v1/models?available=true)`);
    if (!credential && !getModels(model.provider).length && !["test", "camel-test", "cloudflare"].includes(model.provider) && !hooks.endpoints?.[model.provider])
      throw new Error(`${model.provider} provider is gone; set it again with PUT /v1/providers/${model.provider}`);
    if (!credential && !["test", "camel-test", "cloudflare"].includes(model.provider))
      throw new Error(missingModelKey(model.provider, model.id, env));
    if (model.provider === "amazon-bedrock" && !credential?.apiKey && !options.apiKey)
      throw Object.assign(new Error("Bedrock requires an API key"), { code: "model_key_missing" });
    const onPayload = options.onPayload;
    const reasoning = (options as SimpleStreamOptions).reasoning || reasoningFloor(model);
    let transportError: string | undefined;
    const tenantFetch: typeof fetch | undefined = credential?.baseUrl ? async (input, init) => {
      try {
        const original = input instanceof Request ? input.url : String(input);
        const target = FETCH_APIS.includes(model.api) ? gatewayUrl(model, original, credential.baseUrl!) : original;
        const outbound = modelOutbound(env as unknown as Record<string, unknown>);
        await outbound.reachable(target);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!credential.apiKey) { headers.delete("authorization"); headers.delete("x-api-key"); }
        if (credential.deployments) { headers.delete("authorization"); headers.delete("x-api-key"); headers.set("api-key", credential.apiKey!); }
        if (credential.bearer && credential.apiKey) { headers.set("authorization", `Bearer ${credential.apiKey}`); headers.delete("x-api-key"); }
        const response = await (options.fetch ?? fetch)(target, { ...init, headers, redirect:"manual" });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("Custom provider redirects are not allowed"); }
        return response;
      } catch (error) { transportError = error instanceof Error ? error.message : String(error); throw error; }
    } : undefined;
    const prepared = {
      [PREPARED_MODEL_CREDENTIALS]: credential,
      modelCallKind: callKind,
      ...options,
      ...(model.api === "openai-codex-responses" ? { sessionId: await hooks.agentId?.() ?? options.sessionId } : {}), ...(toolChoice !== undefined ? { toolChoice: toolChoice as SimpleStreamOptions["toolChoice"] } : {}), ...callSettings(model, config, config.thinkingLevel),
      ...(reasoning ? { reasoning } : {}),
      ...(fallback || virtualNext ? { supersede: (message: AssistantMessage) => fallback && isContentFilterBlock(message) ? "content_filter" as const : virtualNext && !message.content.length && isModelUnavailable(message) ? "unavailable" as const : undefined } : {}),
      ...(credential ? { apiKey: credential.bearer ? "runtime-bearer" : credential.apiKey ?? "keyless" } : {}),
      ...(credential?.identity ? { endpointIdentity: true } : {}),
      ...(deployment ? { azureDeployment: deployment, env: { AZURE_OPENAI_BASE_URL: credential!.baseUrl!, AZURE_OPENAI_API_VERSION: "v1", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=${deployment}` } } : {}),
      ...(tenantFetch ? { fetch:tenantFetch } : {}),
      ...(model.api === "bedrock-converse-stream" ? { bearerToken: credential?.apiKey ?? options.apiKey, region: credential?.region } : {}),
      headers: { ...credential?.headers, ...options.headers, ...config.modelHeaders, ...(credential?.identity ? { "X-Agent-Runtime-Identity": credential.apiKey } : {}), ...(credential?.bearer && credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}`, "x-api-key": null } : {}) },
      onPayload: async (payload: unknown, target: Model<Api>) => {
        const adjusted = withOpenRouterHosts(target, payload, config.dataCollection ?? undefined);
        return await onPayload?.(adjusted, target) ?? adjusted;
      },
    };
    return { model: credential?.baseUrl && !FETCH_APIS.includes(model.api) ? { ...model, baseUrl: credential.baseUrl } : model, context: normalizeContext(deepseekContext(model, context)), options: prepared, config, fallback, virtualNext, callKind, transportError: () => transportError };
  };
  const wrap = (simple: boolean) => (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        let prepared = await prepare(model, context, options);
        replayRetry.begin(prepared.config.requestId ?? String(context.messages.findLast(message => message.role === "user")?.timestamp ?? 0));
        let retry = false;
        do {
        retry = false;
        let stalled: Promise<void> | undefined;
        const stream = watchedStream(prepared.model, (signal, activity) => {
          const onProviderStreamEvent = prepared.options.onProviderStreamEvent;
          const options = { ...prepared.options, signal, onProviderStreamEvent: (event: unknown) => { activity(event); onProviderStreamEvent?.(event, prepared.model); } };
          return simple ? provider.streamSimple(prepared.model, prepared.context, options as SimpleStreamOptions) : provider.stream(prepared.model, prepared.context, options);
        }, streamTimeouts(prepared.model, prepared.config.thinkingLevel, prepared.config.runLimits, timeouts), options?.signal,
        stall => { stalled = Promise.resolve(hooks.onStall?.({ ...stall, provider: prepared.model.provider, model: prepared.model.id })); });
        for await (const event of stream) {
          if (event.type === "error" || event.type === "done") await stalled;
          if (event.type === "error" && event.reason !== "aborted" && !isStalled(event.error.errorMessage) && prepared.transportError()) event.error.errorMessage = prepared.transportError();
          // Pi retries transient provider errors. OpenRouter's DeepSeek replay
          // refusal is a 400, but the source runtime also retries this exact
          // request so OpenRouter can choose another host. Keep the prepared
          // context and payload unchanged, and never retry a tenant endpoint.
          if (event.type === "error" && event.reason !== "aborted" && prepared.model.provider === "openrouter" &&
              !prepared.options.endpointIdentity && refusedReasoningReplay(event.error.errorMessage) &&
              !options?.signal?.aborted && await replayRetry.retry(event.error, options?.signal)) {
            retry = true;
            continue;
          }
          if (event.type === "error" && event.reason !== "aborted" && prepared.virtualNext && !event.error.content.length && isModelUnavailable(event.error) && !options?.signal?.aborted) {
            routing!.failed = prepared.model;
            prepared = await prepare(prepared.virtualNext, context, options);
            retry = true;
            continue;
          }
          if (event.type === "error" && event.reason !== "aborted" && prepared.fallback && isContentFilterBlock(event.error) && !options?.signal?.aborted) {
            try { prepared = await prepare(prepared.fallback, context, options); retry = true; continue; }
            catch { /* If the fallback is unavailable, retain the provider's original refusal. */ }
          }
          if (event.type === "error" && prepared.options.toolChoice !== undefined && /400/.test(event.error.errorMessage ?? "") && /tool.?choice|forced.*tool/i.test(event.error.errorMessage ?? "")) {
            outputRequest.refuse();
            delete prepared.options.toolChoice;
            retry = true;
            continue;
          }
          if (event.type === "done" && prepared.callKind === "response" && !options?.signal?.aborted && outputRequest.remind(event.message, prepared.config)) {
            await hooks.onDiscardedOutput?.(event.message);
            prepared = await prepare(prepared.model, context, options);
            retry = true;
            continue;
          }
          if (routing && event.type === "error") routing.failed = prepared.model;
          if (routing && event.type === "done") { routing.previous = prepared.model; routing.failed = undefined; }
          if (event.type === "done") await replayRetry.success();
          await hooks.onStreamEvent?.(event);
          output.push(event);
        }
        const result = await stream.result();
        if (retry) await hooks.beforeRequest?.();
        else output.end(result);
        } while (retry);
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push({ type: "error", reason, error: message }); output.end(message);
      }
    })();
    return output;
  };
  return { ...provider, stream: wrap(false), streamSimple: wrap(true) };
}

function streamApi(model: Model<Api>, simple: boolean, context: TranscriptContext, options: StreamOptions | undefined) {
  if (model.provider === "azure" && model.api === "openai-completions" && (options as { azureDeployment?: string })?.azureDeployment)
    model = { ...model, id: (options as unknown as { azureDeployment: string }).azureDeployment };
  if ((options as { endpointIdentity?: true })?.endpointIdentity) {
    const [provider, ...id] = model.id.split("/");
    const region = provider === "amazon-bedrock" ? id.shift() : undefined;
    model = { ...model, provider, id: id.join("/") };
    options = { ...options, ...(region ? { region, env: { AWS_REGION: region } } : {}) } as StreamOptions;
    if (model.api === "openai-codex-responses") {
      const token = options.apiKey;
      const key = ["{}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "passthrough" } }), "passthrough"].map(value => btoa(value)).join(".");
      const fetcher = options.fetch ?? fetch;
      options = { ...options, apiKey: key, transport: "sse", maxRetries: 0, fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set("Authorization", `Bearer ${token}`); return fetcher(input, { ...init, headers }); } } as StreamOptions;
    }
  }
  switch (model.api) {
    case "openai-completions": { const target = model as Model<"openai-completions">; return simple ? streamOpenAISimple(target, context, options as SimpleStreamOptions) : streamOpenAI(target, context, options); }
    case "openai-responses": { const target = model as Model<"openai-responses">; return simple ? simpleResponses(target, context, options as SimpleStreamOptions) : streamResponses(target, context, options); }
    case "anthropic-messages": { const target = model as Model<"anthropic-messages">; return simple ? simpleAnthropic(target, context, options as SimpleStreamOptions) : streamAnthropic(target, context, options); }
    case "google-generative-ai": { const target = model as Model<"google-generative-ai">; return simple ? simpleGoogle(target, context, options as SimpleStreamOptions) : streamGoogle(target, context, options); }
    case "bedrock-converse-stream": { const target = model as Model<"bedrock-converse-stream">; return simple ? simpleBedrock(target, context, options as SimpleStreamOptions) : streamBedrock(target, context, options); }
    case "openai-codex-responses": { const target = model as Model<"openai-codex-responses">; return simple ? simpleCodex(target, context, options as SimpleStreamOptions) : streamCodex(target, context, options); }
    case "azure-openai-responses": { const target = model as Model<"azure-openai-responses">; return simple ? simpleAzure(target, context, options as SimpleStreamOptions) : streamAzure(target, context, options); }
    default: throw new Error(`Unsupported provider API ${model.api}`);
  }
}

/** The deterministic provider is opt-in deployment configuration, never a request field. */
export function modelRuntime(
  env: {
    AI: Ai;
    MODEL: string;
    TEST_MODEL?: string;
    TEST_MODEL_BASE_URL?: string;
    TEST_MODEL_API?: Api;
    TEST_MODE?: string;
  } & ImageBindings & ModelTimeoutEnv & { VOLUMES?: FileBindings["VOLUMES"] },
  getTenant: () => Promise<string>,
  hooks: ModelHooks = {},
) {
  const models = createModels();
  const decorate = (provider: Provider) => {
    const authorizeFile = async (key: string) => {
      const agent = await hooks.agentId?.();
      if (!agent || !env.VOLUMES) return false;
      const tenant = await getTenant();
      if (!key.startsWith(`files/${encodeURIComponent(tenant)}/`)) return false;
      const volume = decodeURIComponent(key.split("/")[2] ?? "");
      return env.VOLUMES.getByName(`${tenant}:${volume}`).hasPin(`agent:${agent}`, key);
    };
    const images = withAttachmentReferences(withImageReferences(provider, env, getTenant, authorizeFile), env, getTenant, authorizeFile);
    return withSettings(hooks.wrapProvider ? hooks.wrapProvider(images) : images, hooks, env);
  };
  const contextModels = new Map<string, Model<Api>>();
  const catalogModel = models.getModel.bind(models);
  models.getModel = (provider, id) => contextModels.get(`${provider}/${id}`) ?? catalogModel(provider, id);
  const bounded = <T extends Model<Api>>(model: T, contextTokens?: number): T => {
    const selected = boundedModel(model, contextTokens);
    contextModels.set(`${model.provider}/${model.id}`, selected);
    return selected;
  };
  if (env.TEST_MODEL !== "1") {
    const ai = env.AI ? createAI({ binding: env.AI }) : undefined;
    if (ai) models.setProvider(decorate(ai.provider));
    const catalog = new Map<string, Map<string, Model<Api>>>();
    const install = (providerId: string) => {
      if (catalog.has(providerId)) return;
      const entries = new Map(getModels(providerId).map(model => [model.id, model]));
      catalog.set(providerId, entries);
      const provider: Provider = {
        id: providerId, name: providerId,
        auth: { apiKey: { name: providerId, resolve: async () => {
          const credential = await hooks.credentials?.(providerId);
          return credential ? { auth: { apiKey: credential.bearer ? "runtime-bearer" : credential.apiKey ?? "keyless", baseUrl: credential.baseUrl, headers: credential.headers } } : { auth: {} };
        } } },
        getModels: () => [...entries.values()],
        stream: (model, context, options) => streamApi(model, false, context, options),
        streamSimple: (model, context, options) => streamApi(model, true, context, options),
      };
      models.setProvider(decorate(provider));
    };
    const resolve = (name = env.MODEL, contextTokens?: number, customProviders?: CustomProviders, endpoints?: ModelEndpoints, resolvedModel?: Model<Api>): Model<Api> => {
      if (endpoints) hooks.endpoints = endpoints;
      if (name.startsWith("cloudflare/") || name.startsWith("@cf/")) {
        if (!ai) throw new Error("Workers AI is not configured");
        return bounded(ai(name.replace(/^cloudflare\//, "")), contextTokens);
      }
      const selected = resolvedModel ?? resolveModel(name, hooks.endpoints, customProviders ?? hooks.customProviders);
      for (const target of virtualChain(name) ?? [selected]) { install(target.provider); catalog.get(target.provider)!.set(target.id, target); }
      return bounded(selected, contextTokens);
    };
    return { models, model: resolve(), resolve };
  }
  const model: Model<"openai-completions"> = {
    id: "deterministic",
    name: "Local deterministic test model",
    provider: "camel-test",
    api: "openai-completions",
    baseUrl: "https://invalid.test",
    input: ["text", "image"],
    reasoning: false,
    contextWindow: 32768,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (env.TEST_MODEL_BASE_URL) {
    const endpoint = new URL(env.TEST_MODEL_BASE_URL);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.protocol !== "http:"
    )
      throw new Error("Test model URL must be loopback HTTP");
    const catalog = new Map<string, Model<Api>>();
    const install = (providerId: string) => {
      if (models.getProvider(providerId)) return;
      const serve = (target: Model<Api>, simple: boolean, context: TranscriptContext, options?: StreamOptions) =>
        target.baseUrl === endpoint.href
          ? streamApi({ ...target, api: env.TEST_MODEL_API ?? "openai-completions" }, simple, context, options)
          : streamApi(target, simple, context, options);
      models.setProvider(decorate({
        id: providerId, name: "Local compatibility fixture", baseUrl: endpoint.href,
        auth: { apiKey: { name: "Local fixture", resolve: async () => ({ auth: { apiKey: "fixture-model-key" } }) } },
        getModels: () => [...catalog.values()].filter(entry => entry.provider === providerId),
        stream: (target, context, options) => serve(target, false, context, options),
        streamSimple: (target, context, options) => serve(target, true, context, options),
      }));
    };
    const resolve = (name = "test/echo", contextTokens?: number, customProviders?: CustomProviders, endpoints?: ModelEndpoints, resolvedModel?: Model<Api>) => {
      if (endpoints) hooks.endpoints = endpoints;
      const custom = customProviders ?? hooks.customProviders;
      const selected = name.startsWith("test/") || name.startsWith("camel-test/")
        ? { ...model, provider: name.split("/")[0], id: name.slice(name.indexOf("/") + 1) }
        : resolvedModel ?? resolveModel(name, hooks.endpoints, custom);
      const ownTransport = custom?.[selected.provider] || hooks.endpoints?.[selected.provider];
      const transported = { ...selected, runtimeApi: selected.api, ...(!ownTransport ? { api: env.TEST_MODEL_API ?? "openai-completions" as const } : {}), baseUrl: ownTransport ? selected.baseUrl : endpoint.href };
      catalog.set(name, transported);
      install(transported.provider);
      return bounded(transported, contextTokens);
    };
    return { models, model: resolve(env.MODEL), resolve };
  }
  const stream = (
    _model: Model<any>,
    context: TranscriptContext,
    options?: { signal?: AbortSignal },
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const latest = [...context.messages]
        .reverse()
        .find((message) => message.role === "user");
      const text =
        latest?.role === "user"
          ? typeof latest.content === "string"
            ? latest.content
            : latest.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
          : "";
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        timestamp: Date.now(),
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      try {
        output.push({ type: "start", partial: structuredClone(message) });
        const slow = /^slow:(\d+):(.*)$/s.exec(text);
        if (slow)
          await new Promise<void>((resolve, reject) => {
            if (options?.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            };
            const timer = setTimeout(
              () => {
                options?.signal?.removeEventListener("abort", onAbort);
                resolve();
              },
              Math.min(Number(slow[1]), 15000),
            );
            options?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        const tool = /^tool:write:(.*)$/s.exec(text);
        const code = /^code:(.*)$/s.exec(text);
        const ask = /^ask:(.*)$/s.exec(text);
        const delegate = /^delegate:(.*)$/s.exec(text);
        const afterLatestUser = latest
          ? context.messages.slice(context.messages.lastIndexOf(latest) + 1)
          : [];
        if (
          (tool || code || ask || delegate) &&
          !afterLatestUser.some((item) => item.role === "toolResult")
        ) {
          const call: ToolCall = ask
            ? {
                type: "toolCall",
                id: "ask-human",
                name: "ask_human",
                arguments: { question: ask[1] },
              }
            : delegate
              ? {
                  type: "toolCall",
                  id: "delegate-task",
                  name: "delegate",
                  arguments: { task: delegate[1] },
                }
              : code
                ? {
                    type: "toolCall" as const,
                    id: "run-code",
                    name: "codemode",
                    arguments: { code: code[1] },
                  }
                : {
                    type: "toolCall" as const,
                    id: "write-model-file",
                    name: "write",
                    arguments: {
                      path: "/workspace/model.txt",
                      content: tool![1],
                    },
                  };
          message.content = [call];
          message.stopReason = "toolUse";
          output.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: structuredClone(message),
          });
          output.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: call,
            partial: structuredClone(message),
          });
          output.push({ type: "done", reason: "toolUse", message });
        } else {
          const results = afterLatestUser.filter(
            (item) => item.role === "toolResult",
          );
          const answer =
            code || ask || delegate
              ? JSON.stringify(results)
              : `Echo: ${slow?.[2] ?? tool?.[1] ?? text}`;
          message.content = [{ type: "text", text: "" }];
          output.push({
            type: "text_start",
            contentIndex: 0,
            partial: structuredClone(message),
          });
          message.content = [{ type: "text", text: answer }];
          output.push({
            type: "text_delta",
            contentIndex: 0,
            delta: answer,
            partial: structuredClone(message),
          });
          output.push({
            type: "text_end",
            contentIndex: 0,
            content: answer,
            partial: structuredClone(message),
          });
          output.push({ type: "done", reason: "stop", message });
        }
      } catch {
        message.stopReason = "aborted";
        message.errorMessage = "Aborted";
        output.push({ type: "error", reason: "aborted", error: message });
      }
    })();
    return output;
  };
  const provider: Provider<"openai-completions"> = {
    id: model.provider,
    name: "Local test",
    auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model],
    stream,
    streamSimple: stream,
  };
  models.setProvider(decorate(provider));
  return {
    models,
    model,
    resolve: (name?: string, contextTokens?: number, _customProviders?: CustomProviders, _endpoints?: ModelEndpoints, _resolvedModel?: Model<Api>) => {
      if (name && !["test/echo", "camel-test/deterministic"].includes(name))
        throw Object.assign(new Error("Unsupported test model"), {
          status: 400,
        });
      return bounded(model, contextTokens);
    },
  };
}

/** The same model metadata as ECS; credentials are resolved only when a request executes. */
export function modelCatalog(env: { MODEL: string; TEST_MODEL?: string }, provider?: string) {
  return listModels(provider);
}
