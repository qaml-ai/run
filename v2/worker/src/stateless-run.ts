import type { ImageContent, Message as PiAiMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { randomId } from "./crypto.ts";
import { DEFAULT_MODEL_ID, addModelUsage, streamPiModel } from "./pi/models.ts";
import type { ModelImage } from "./run-files.ts";
import { getTenantStub } from "./tenant-do.ts";
import {
  ApiError,
  emptyUsage,
  type CustomToolSpec,
  type Env,
  type LlmToolSchema,
  type ToolCallInvocation,
  type ToolCallSummary,
} from "./types.ts";

export interface StatelessRunImage {
  mediaType: string;
  data: string;
}

export const MAX_STATELESS_RUN_IMAGES = 8;
export const MAX_STATELESS_RUN_IMAGES_BASE64_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPE_RE = /^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseStatelessRunImages(raw: unknown): ModelImage[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "invalid_request", "`images` must be an array of { mediaType, data } objects");
  }
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_STATELESS_RUN_IMAGES) {
    throw new ApiError(400, "invalid_request", `At most ${MAX_STATELESS_RUN_IMAGES} images may be attached`);
  }

  let totalBase64Bytes = 0;
  const parsed: ModelImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "invalid_request", "Each image must be an object with `mediaType` and `data`");
    }
    const { mediaType: rawMediaType, data: rawData } = item as { mediaType?: unknown; data?: unknown };
    const mediaType = typeof rawMediaType === "string" ? rawMediaType.trim().toLowerCase() : "";
    if (!IMAGE_MEDIA_TYPE_RE.test(mediaType)) {
      throw new ApiError(400, "invalid_request", "Each image must have a valid `image/*` mediaType");
    }
    if (typeof rawData !== "string") {
      throw new ApiError(400, "invalid_request", "Each image must have non-empty base64 `data`");
    }
    const data = rawData.trim();
    if (!data) {
      throw new ApiError(400, "invalid_request", "Each image must have non-empty base64 `data`");
    }
    totalBase64Bytes += data.length;
    if (totalBase64Bytes > MAX_STATELESS_RUN_IMAGES_BASE64_BYTES) {
      throw new ApiError(
        400,
        "invalid_request",
        `Total image payload exceeds ${MAX_STATELESS_RUN_IMAGES_BASE64_BYTES} base64 bytes`,
      );
    }
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      throw new ApiError(400, "invalid_request", "Each image `data` must be valid base64");
    }
    parsed.push({ contentType: mediaType, base64: data });
  }
  return parsed;
}

export interface StatelessRunInput {
  model?: string;
  instructions?: string;
  input: string;
  images?: StatelessRunImage[];
  outputSchema?: Record<string, unknown> | null;
  tools?: CustomToolSpec[];
  maxSteps?: number;
}

export async function executeStatelessRun(
  env: Env,
  tenantId: string,
  body: StatelessRunInput,
  signal?: AbortSignal,
  confirmUsage = false,
  onCacheRead?: (tokens: number) => void,
) {
  if (typeof body.input !== "string") {
    throw new ApiError(400, "invalid_request", "`input` must be a string");
  }
  const parsedImages = parseStatelessRunImages(body.images);

  const runId = randomId("run", 8);
  const model = (body.model || env.DEFAULT_MODEL || DEFAULT_MODEL_ID).trim();
  const maxSteps = Math.max(1, Math.min(25, Number(body.maxSteps ?? 10)));
  const customTools = body.tools ?? [];

  const toolSchemas: LlmToolSchema[] = customTools.map((t) => ({
    name: t.name,
    description: t.description || `Tool ${t.name}`,
    parameters: t.parameters ?? { type: "object", properties: {} },
  }));
  const toolByName = new Map(customTools.map((t) => [t.name, t]));

  const initialUserContent: string | (TextContent | ImageContent)[] = parsedImages
    ? [
        ...(body.input ? [{ type: "text" as const, text: body.input }] : []),
        ...parsedImages.map((img) => ({
          type: "image" as const,
          mimeType: img.contentType,
          data: img.base64,
        })),
      ]
    : body.input;

  const messages: PiAiMessage[] = [
    {
      role: "user",
      content: initialUserContent,
      timestamp: Date.now(),
    },
  ];
  const usage = emptyUsage();
  const toolCallsSummary: ToolCallSummary[] = [];
  let finalText = "";
  let structuredOutput: unknown = null;
  let error: { code: string; message: string } | null = null;

  for (let step = 0; step < maxSteps; step++) {
    let stepText = "";
    const stepCalls: ToolCallInvocation[] = [];
    let assistantMessage: PiAiMessage | null = null;

    for await (const chunk of streamPiModel({
      env,
      tenantId,
      model,
      instructions: body.instructions,
      messages,
      tools: toolSchemas,
      outputSchema: body.outputSchema ?? null,
      signal,
    })) {
      if (chunk.type === "text_delta") {
        stepText += chunk.delta;
      } else if (chunk.type === "tool_call") {
        stepCalls.push({
          id: chunk.id,
          name: chunk.name,
          argumentsJson: chunk.argumentsJson,
          args: chunk.args,
        });
      } else if (chunk.type === "done") {
        const cacheRead = chunk.cacheReadTokens ?? 0;
        addModelUsage(usage, model, chunk.inputTokens, chunk.outputTokens, cacheRead);
        if (cacheRead) onCacheRead?.(cacheRead);
        assistantMessage = chunk.message;
      }
    }

    if (stepText) finalText = stepText;
    if (assistantMessage) {
      messages.push(assistantMessage);
    }

    if (stepCalls.length === 0) {
      if (body.outputSchema) {
        try {
          structuredOutput = JSON.parse(finalText.trim());
          if (confirmUsage && (!structuredOutput || typeof structuredOutput !== "object" || Array.isArray(structuredOutput))) {
            error = { code: "output_missing", message: "The model returned no structured output" };
          }
        } catch {
          if (!confirmUsage) throw new ApiError(422, "output_schema_invalid", "Stateless run response was not valid JSON");
          error = { code: "output_missing", message: "The model returned no structured output" };
        }
      }
      break;
    }

    for (const tc of stepCalls) {
      const spec = toolByName.get(tc.name);
      if (!spec?.url) {
        toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
        const errMsg: ToolResultMessage = {
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: `Stateless tool '${tc.name}' requires a webhook url` }) }],
          timestamp: Date.now(),
        };
        messages.push(errMsg);
        continue;
      }

      try {
        const res = await fetch(spec.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(spec.headers ?? {}),
          },
          body: JSON.stringify({
            callId: tc.id,
            runId,
            name: tc.name,
            args: tc.args,
          }),
          signal,
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        toolCallsSummary.push({ id: tc.id, name: tc.name, ok: true });
        messages.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: false,
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
        messages.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
          timestamp: Date.now(),
        });
      }
    }
  }

  if (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.costUsd > 0) {
    const settlement = getTenantStub(env, tenantId)
      .settleUsage({
        refId: `srun:${runId}`,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        vmMs: 0,
        costUsd: usage.costUsd,
        note: "POST /v2/runs",
      });
    if (confirmUsage) await settlement;
    else await settlement.catch(() => {});
  }

  return {
    id: runId,
    agentId: null,
    status: error ? "failed" : "completed",
    text: finalText,
    output: structuredOutput,
    batchedInto: null,
    inputs: [],
    toolCalls: toolCallsSummary,
    filesChanged: [],
    usage,
    error,
  };
}
