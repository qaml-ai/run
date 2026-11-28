import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import runtime, { AgentDO as RuntimeAgentDO } from "../../worker/src/index.ts";
import { parseMarker } from "../../worker/src/pi/image-request-marker.ts";
import { buildPiModels, parsePiModelRef } from "../../worker/src/pi/models.ts";
import type { Env, ProviderCredentials } from "../../worker/src/types.ts";

export { CamelfsLineageDO, TenantDO } from "../../worker/src/index.ts";

export interface PiEntryImage {
  kind: string;
  recordBytes: number;
  inlineLength: number;
  marker: boolean;
}

export class AgentDO extends RuntimeAgentDO {
  constructor(ctx: DurableObjectState, env: Env & { TEST_RESIZED_PNG: string }) {
    const bytes = Uint8Array.from(atob(env.TEST_RESIZED_PNG), char => char.charCodeAt(0));
    // Stub the transformation service. The derivative is still written to and streamed from real R2.
    const images = {
      input(stream: ReadableStream<Uint8Array>): ImageTransformer {
        const transformed: ImageTransformer = {
          transform: () => transformed,
          draw: () => transformed,
          async output() {
            await stream.cancel();
            return {
              response: () => new Response(bytes),
              contentType: () => "image/png",
              image: () => new Blob([bytes]).stream(),
            };
          },
        };
        return transformed;
      },
    } as ImagesBinding;
    super(ctx, { ...env, IMAGES: images });
  }

  readEntryImages(): PiEntryImage[] {
    const images: PiEntryImage[] = [];
    for (const { record } of this.ctx.storage.sql.exec<{ record: string }>("SELECT record FROM pi_entries ORDER BY id")) {
      const entry = JSON.parse(record) as { kind: string; model?: Array<{ content?: string | ImageContent[] }> };
      for (const message of entry.model ?? []) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          if (block.type !== "image") continue;
          images.push({
            kind: entry.kind,
            recordBytes: new TextEncoder().encode(record).length,
            inlineLength: block.data.length,
            marker: Boolean(parseMarker(block.data)),
          });
        }
      }
    }
    return images;
  }
}

export interface ModelImageProbe {
  payload?: string;
  streamed?: boolean;
  contentLength?: string | null;
  contentEncoding?: string | null;
  authorization?: string | null;
  gatewayAuthorization?: string | null;
  upload?: string;
  headersBeforeRead?: number;
  stopReason: string;
  errorMessage?: string;
}

export type ProbeAdapter = "chat" | "responses" | "azure" | "anthropic" | "gemini" | "codex";

const codexToken = `fixture.${btoa(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).replace(/=+$/, "")}.fixture`;
const adapters: Record<ProbeAdapter, { model: string; credentials: Omit<ProviderCredentials, "provider"> }> = {
  chat: { model: "openai/gpt-4o", credentials: {
    apiKey: "", apiStyle: "openai-chat", baseUrl: "https://fake-provider.invalid/v1",
    headers: { "cf-aig-authorization": "fixture-gateway-auth" },
  } },
  responses: { model: "openai/gpt-5.4", credentials: {
    apiKey: "fixture-key", apiStyle: "openai-responses", baseUrl: "https://fake-provider.invalid/v1",
  } },
  azure: { model: "azure/gpt-6.2-sol", credentials: {
    apiKey: "fixture-key", baseUrl: "https://fake-provider.invalid/openai/v1",
  } },
  anthropic: { model: "anthropic/claude-sonnet-4", credentials: {
    apiKey: "fixture-key", baseUrl: "https://fake-provider.invalid",
  } },
  gemini: { model: "gemini/gemini-3-flash-preview", credentials: {
    apiKey: "fixture-key", baseUrl: "https://fake-provider.invalid/v1beta",
  } },
  codex: { model: "openai-codex/gpt-5.4", credentials: {
    apiKey: codexToken, baseUrl: "https://fake-provider.invalid/backend-api",
  } },
};

async function probeModels(request: Request, env: Env): Promise<ModelImageProbe> {
  const { tenantId, content, useStream, disableBucket, adapter = "chat" } = await request.json<{
    tenantId: string;
    content: (TextContent | ImageContent)[];
    useStream?: boolean;
    disableBucket?: boolean;
    adapter?: ProbeAdapter;
  }>();
  const observations: Partial<ModelImageProbe> = {};
  const bucket = env.MEDIA_BUCKET!;
  let gets = 0;
  const mediaBucket = new Proxy(bucket, {
    get(target, property) {
      if (property === "get") return (key: string) => {
        gets++;
        return target.get(key);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { model: rawModel, credentials } = adapters[adapter];
  const { provider, modelId } = parsePiModelRef(rawModel, env);
  const registry = await buildPiModels({
    env: { ...env, MEDIA_BUCKET: disableBucket ? undefined : mediaBucket },
    tenantId,
    rawModel,
    prefetchedCredentials: { [provider]: { provider, ...credentials } },
  });
  const model = registry.getModel(provider, modelId)!;
  const fetcher: typeof fetch = async (_input, init) => {
    observations.headersBeforeRead = gets;
    observations.streamed = init?.body instanceof ReadableStream;
    const headers = new Headers(init?.headers);
    observations.contentLength = headers.get("content-length");
    observations.contentEncoding = headers.get("content-encoding");
    observations.authorization = headers.get("authorization");
    observations.gatewayAuthorization = headers.get("cf-aig-authorization");
    observations.upload = await new Response(init?.body).text();
    if (adapter !== "chat") return Response.json({ error: { message: "fixture captured request" } }, { status: 400 });
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"image seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const context = { messages: [{ role: "user" as const, content, timestamp: Date.now() }] };
  const options = {
    fetch: fetcher,
    maxRetries: 0,
    transport: "websocket" as const,
    onPayload: (payload: unknown) => { observations.payload = JSON.stringify(payload); },
  };
  const result = await (useStream
    ? registry.stream(model, context, options)
    : registry.streamSimple(model, context, options)).result();
  return { ...observations, stopReason: result.stopReason, errorMessage: result.errorMessage };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_test/model-image") return Response.json(await probeModels(request, env));
    if (url.pathname === "/_test/pi-images") {
      const stub = env.AGENT_DO.getByName(url.searchParams.get("id")!) as unknown as AgentDO;
      return Response.json(await stub.readEntryImages());
    }
    return runtime.fetch(request, env, ctx);
  },
};
