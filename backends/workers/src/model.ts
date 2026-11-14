import "./model-bedrock.ts";
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
import { stream as streamCodex, streamSimple as simpleCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamAzure, streamSimple as simpleAzure } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { getModels } from "./model-catalog.ts";
import { resolveModel, virtualChain, virtualModelReferences, type ModelEndpoints, type CustomProviders } from "./model-policy.ts";
import { boundedModel } from "./model-context.ts";
import { listModels } from "./catalog-policy.ts";
import { type ModelTimeoutEnv } from "./model-runtime-options.ts";

export type { ModelRequestSettings, ModelCredentials, ModelHooks } from "./model-settings.ts";
import { withSettings, type ModelHooks } from "./model-settings.ts";

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
    const images = withAttachmentReferences(withImageReferences(provider, env, getTenant), env as FileBindings & import("./repos/registry.ts").RepoEnv, getTenant, undefined,hooks.authorizeRepoFile);
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
      // Resolution selects the fixture protocol; withSettings may subsequently
      // restore a scope's native API even when an unknown model has no catalog root.
      const serve = (target: Model<Api>, simple: boolean, context: TranscriptContext, options?: StreamOptions) =>
        streamApi(target, simple, context, options);
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
