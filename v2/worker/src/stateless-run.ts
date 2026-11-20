import { randomId } from "./crypto.ts";
import {
  DEFAULT_MODEL_ID,
  addModelUsage,
  streamModelResponse,
  type ConversationMessage,
} from "./providers.ts";
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

export interface StatelessRunInput {
  model?: string;
  instructions?: string;
  input: string;
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
): Promise<Record<string, unknown>> {
  if (typeof body.input !== "string") {
    throw new ApiError(400, "invalid_request", "`input` must be a string");
  }

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

  const messages: ConversationMessage[] = [{ role: "user", text: body.input }];
  const usage = emptyUsage();
  const toolCallsSummary: ToolCallSummary[] = [];
  let finalText = "";
  let structuredOutput: unknown = null;
  let error: { code: string; message: string } | null = null;

  for (let step = 0; step < maxSteps; step++) {
    let stepText = "";
    const stepCalls: ToolCallInvocation[] = [];

    for await (const chunk of streamModelResponse({
      env,
      tenantId,
      model,
      instructions: body.instructions,
      messages,
      tools: toolSchemas,
      outputSchema: body.outputSchema ?? null,
      signal,
      purpose: "turn",
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
        addModelUsage(usage, model, chunk.inputTokens, chunk.outputTokens);
      }
    }

    if (stepText) finalText = stepText;
    messages.push({
      role: "assistant",
      text: stepText,
      toolCalls: stepCalls.length > 0 ? stepCalls : undefined,
    });

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
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: true,
          text: JSON.stringify({ error: `Stateless tool '${tc.name}' requires a webhook url` }),
        });
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
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: false,
          text,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolCallsSummary.push({ id: tc.id, name: tc.name, ok: false });
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          toolName: tc.name,
          isError: true,
          text: JSON.stringify({ error: msg }),
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
