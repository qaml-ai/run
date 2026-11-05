import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import {
  stream as streamOpenAI,
  streamSimple as streamOpenAISimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { withImageReferences, type ImageBindings } from "./images.ts";
import { createAI } from "agents/models/pi-ai";

/** The deterministic provider is opt-in deployment configuration, never a request field. */
export function modelRuntime(
  env: {
    AI: Ai;
    MODEL: string;
    TEST_MODEL?: string;
    TEST_MODEL_BASE_URL?: string;
  } & ImageBindings,
  getTenant: () => Promise<string>,
) {
  const models = createModels();
  if (env.TEST_MODEL !== "1") {
    const ai = createAI({ binding: env.AI });
    models.setProvider(withImageReferences(ai.provider, env, getTenant));
    const resolve = (name = env.MODEL) => {
      const target = name.startsWith("cloudflare/")
        ? name.slice("cloudflare/".length)
        : name;
      if (!target.startsWith("@cf/"))
        throw Object.assign(
          new Error("Only Cloudflare Workers AI models are supported"),
          { status: 400 },
        );
      const model = ai(target);
      if (!models.getModel(model.provider, model.id))
        throw Object.assign(new Error("Unknown Workers AI model"), {
          status: 400,
        });
      return model;
    };
    return { models, model: resolve(), resolve };
  }
  const model: Model<"openai-completions"> = {
    id: "deterministic",
    name: "Local deterministic test model",
    provider: "camel-test",
    api: "openai-completions",
    baseUrl: "https://invalid.test",
    input: ["text"],
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
    const resolve = (name = "test/echo") => {
      let selected = catalog.get(name);
      if (!selected) {
        selected = { ...model, id: name, baseUrl: endpoint.href };
        catalog.set(name, selected);
      }
      return selected;
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
    models.setProvider(withImageReferences(provider, env, getTenant));
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
  models.setProvider(withImageReferences(provider, env, getTenant));
  return {
    models,
    model,
    resolve: (name?: string) => {
      if (name && !["test/echo", "camel-test/deterministic"].includes(name))
        throw Object.assign(new Error("Unsupported test model"), {
          status: 400,
        });
      return model;
    },
  };
}
