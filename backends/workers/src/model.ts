import {
  createAssistantMessageEventStream,
  type AssistantMessage,
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
import { getModels, callSettings, withOpenRouterHosts } from "./model-catalog.ts";
import { resolveModel, virtualChain, routeModel, virtualModelReferences, type ModelEndpoints, type CustomProviders } from "./model-policy.ts";
import { deepseekContext } from "./deepseek-policy.ts";
import { forcedToolChoice, OUTPUT_INSTRUCTIONS } from "./output-policy.ts";
import { normalizeContext, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { boundedModel } from "./model-context.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { sourceUrl } from "./tool-sources.ts";
import { listModels } from "./catalog-policy.ts";
import { streamTimeouts, watchedStream, isStalled } from "./model-stream.ts";

export type ModelRequestSettings = AgentConfiguration & { output?: { schema?: Record<string, unknown>; [key: string]: unknown } };
export type ModelCredentials = { apiKey?: string; baseUrl?: string; headers?: Record<string, string>; region?: string; bearer?: true };
export type ModelHooks = {
  agentId?: () => Promise<string>;
  wrapProvider?: (provider: Provider) => Provider;
  settings?: () => Promise<ModelRequestSettings>;
  credentials?: (provider: string) => Promise<ModelCredentials | undefined>;
  endpoints?: ModelEndpoints;
  customProviders?: CustomProviders;
};

function withSettings(provider: Provider, hooks: ModelHooks, env: { TEST_MODE?: string }): Provider {
  let routing: { user: number; previous?: Model<Api>; failed?: Model<Api> } | undefined;
  const prepare = async (model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
    const config = await hooks.settings?.() ?? {};
    if (config.model?.startsWith("camelrun/")) {
      const user = [...context.messages].reverse().find(message => message.role === "user")?.timestamp ?? 0;
      if (!routing || routing.user !== user) routing = { user };
      const selected = routeModel(resolveModel(config.model), { reason: routing.failed ? "retry" : routing.previous ? "continuation" : "user", failed: routing.failed, previous: routing.previous });
      if (!selected) throw new Error("Virtual model fallback chain is exhausted");
      model = boundedModel(selected, config.runLimits?.contextTokens);
    }
    const outputSchema = config.output?.schema;
    const currentTools = getCurrentTools(context.messages).filter(tool => tool.name !== "final_output");
    let toolChoice: unknown;
    if (outputSchema) {
      const finalTool = { name: "final_output", description: "Give the final answer as the arguments of this tool. The turn ends when the answer is accepted.", parameters: outputSchema };
      context = normalizeContext({ messages: [...context.messages, { role: "system", content: "", sections: { structured_output: OUTPUT_INSTRUCTIONS }, toolsAdded: [finalTool], timestamp: Date.now() }] });
      if (!currentTools.length) toolChoice = forcedToolChoice(model, "final_output", { sole: true, thinking: (config.thinkingLevel ?? "off") !== "off" });
    } else {
      context = normalizeContext({ messages: [...context.messages, { role: "system", content: "", toolsRemoved: [{ name: "final_output" }], timestamp: Date.now() }] });
    }
    const credential = await hooks.credentials?.(model.provider);
    if (model.provider === "amazon-bedrock" && !credential?.apiKey && !options.apiKey)
      throw Object.assign(new Error("Bedrock requires an API key"), { code: "model_key_missing" });
    const onPayload = options.onPayload;
    let transportError: string | undefined;
    const tenantFetch: typeof fetch | undefined = credential?.baseUrl ? async (input, init) => {
      try {
        const target = sourceUrl(input instanceof Request ? input.url : String(input), env);
        if (target.origin !== new URL(credential.baseUrl!).origin) throw new Error("Custom provider request changed origin");
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!credential.apiKey) { headers.delete("authorization"); headers.delete("x-api-key"); }
        if (credential.bearer && credential.apiKey) { headers.set("authorization", `Bearer ${credential.apiKey}`); headers.delete("x-api-key"); }
        const response = await (options.fetch ?? fetch)(input, { ...init, headers, redirect:"manual" });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("Custom provider redirects are not allowed"); }
        return response;
      } catch (error) { transportError = error instanceof Error ? error.message : String(error); throw error; }
    } : undefined;
    const prepared = {
      ...options, ...(toolChoice !== undefined ? { toolChoice: toolChoice as SimpleStreamOptions["toolChoice"] } : {}), ...callSettings(model, config, config.thinkingLevel),
      ...(credential ? { apiKey: credential.bearer ? "runtime-bearer" : credential.apiKey ?? "keyless" } : {}),
      ...(tenantFetch ? { fetch:tenantFetch } : {}),
      ...(model.provider === "amazon-bedrock" ? { bearerToken: credential?.apiKey ?? options.apiKey, region: credential?.region } : {}),
      headers: { ...credential?.headers, ...options.headers, ...config.modelHeaders, ...(credential?.bearer && credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}`, "x-api-key": null } : {}) },
      onPayload: async (payload: unknown, target: Model<Api>) => {
        const adjusted = withOpenRouterHosts(target, payload, config.dataCollection ?? undefined);
        return await onPayload?.(adjusted, target) ?? adjusted;
      },
    };
    return { model: credential?.baseUrl ? { ...model, baseUrl: credential.baseUrl } : model, context: normalizeContext(deepseekContext(model, context)), options: prepared, config, transportError: () => transportError };
  };
  const wrap = (simple: boolean) => (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const prepared = await prepare(model, context, options);
        const stream = watchedStream(prepared.model, (signal, activity) => {
          const onProviderStreamEvent = prepared.options.onProviderStreamEvent;
          const options = { ...prepared.options, signal, onProviderStreamEvent: (event: unknown) => { activity(event); onProviderStreamEvent?.(event, prepared.model); } };
          return simple ? provider.streamSimple(prepared.model, prepared.context, options as SimpleStreamOptions) : provider.stream(prepared.model, prepared.context, options);
        }, streamTimeouts(prepared.model, prepared.config.thinkingLevel, prepared.config.runLimits), options?.signal);
        for await (const event of stream) {
          if (event.type === "error" && event.reason !== "aborted" && !isStalled(event.error.errorMessage) && prepared.transportError()) event.error.errorMessage = prepared.transportError();
          if (routing && event.type === "error") routing.failed = prepared.model;
          if (routing && event.type === "done") { routing.previous = prepared.model; routing.failed = undefined; }
          output.push(event);
        }
        output.end(await stream.result());
      } catch (error) {
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push({ type: "error", reason: "error", error: message }); output.end(message);
      }
    })();
    return output;
  };
  return { ...provider, stream: wrap(false), streamSimple: wrap(true) };
}

/** The deterministic provider is opt-in deployment configuration, never a request field. */
export function modelRuntime(
  env: {
    AI: Ai;
    MODEL: string;
    TEST_MODEL?: string;
    TEST_MODEL_BASE_URL?: string;
    TEST_MODE?: string;
  } & ImageBindings & { VOLUMES?: FileBindings["VOLUMES"] },
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
    const api = (model: Model<Api>, simple: boolean, context: TranscriptContext, options: StreamOptions | undefined) => {
      switch (model.api) {
        case "openai-completions": { const target = model as Model<"openai-completions">; return simple ? streamOpenAISimple(target, context, options as SimpleStreamOptions) : streamOpenAI(target, context, options); }
        case "openai-responses": { const target = model as Model<"openai-responses">; return simple ? simpleResponses(target, context, options as SimpleStreamOptions) : streamResponses(target, context, options); }
        case "anthropic-messages": { const target = model as Model<"anthropic-messages">; return simple ? simpleAnthropic(target, context, options as SimpleStreamOptions) : streamAnthropic(target, context, options); }
        case "google-generative-ai": { const target = model as Model<"google-generative-ai">; return simple ? simpleGoogle(target, context, options as SimpleStreamOptions) : streamGoogle(target, context, options); }
        case "bedrock-converse-stream": { const target = model as Model<"bedrock-converse-stream">; return simple ? simpleBedrock(target, context, options as SimpleStreamOptions) : streamBedrock(target, context, options); }
        default: throw new Error(`Unsupported provider API ${model.api}`);
      }
    };
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
        stream: (model, context, options) => api(model, false, context, options),
        streamSimple: (model, context, options) => api(model, true, context, options),
      };
      models.setProvider(decorate(provider));
    };
    const resolve = (name = env.MODEL, contextTokens?: number, customProviders?: CustomProviders): Model<Api> => {
      if (name.startsWith("cloudflare/") || name.startsWith("@cf/")) {
        if (!ai) throw new Error("Workers AI is not configured");
        return bounded(ai(name.replace(/^cloudflare\//, "")), contextTokens);
      }
      const selected = resolveModel(name, hooks.endpoints, customProviders ?? hooks.customProviders);
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
    const catalog = new Map<string, Model<"openai-completions">>();
    const resolve = (name = "test/echo", contextTokens?: number, _customProviders?: CustomProviders) => {
      let selected = catalog.get(name);
      if (!selected) {
        const logicalProvider = name.includes("/") ? name.slice(0, name.indexOf("/")) : model.provider;
        selected = { ...model, provider: logicalProvider, id: name, baseUrl: endpoint.href };
        catalog.set(name, selected);
        if (!models.getProvider(logicalProvider)) models.setProvider(decorate({ ...provider, id: logicalProvider }));
      }
      return bounded(selected, contextTokens);
    };
    const provider: Provider<"openai-completions"> = {
      id: model.provider,
      name: "Local compatibility fixture",
      baseUrl: endpoint.href,
      auth: {
        apiKey: {
          name: "Local fixture",
          resolve: async () => ({ auth: { apiKey: "fixture-model-key" } }),
        },
      },
      getModels: () => [...catalog.values()],
      stream: streamOpenAI,
      streamSimple: streamOpenAISimple,
    };
    models.setProvider(decorate(provider));
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
    resolve: (name?: string, contextTokens?: number, _customProviders?: CustomProviders) => {
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
  if (env.TEST_MODEL === "1") return [{ id: env.MODEL, modelId: env.MODEL, name: env.MODEL, provider: "fixture", input: ["text", "image"], contextWindow: 32768, maxTokens: 2048 }];
  return listModels(provider);
}
