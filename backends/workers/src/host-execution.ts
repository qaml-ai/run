import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry, ToolResultEntry, ToolTask, configure, defineDoc, defineDocFamily,
  type Conversation, type ConversationId, type Harness, type TaskId, type ToolRegistration, type ToolTaskResult,
} from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandboxBase, type CodemodeResult, type CodemodeRunOptions } from "@earendil-works/pi-codemode/portable";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";

export const HOST_EXECUTION_TOOL = "host_execute";
export type ExecutionParams = { code: string; timeoutMs?: number; maxOutputCharacters?: number };
export type ExecutionResult = {
  output: string[]; truncated: boolean;
  error?: { kind: string; message: string; name?: string };
};
const Executions = defineDocFamily<{ task?: number; fingerprint?: string }, null>({
  kind: "camel.host-execution", version: 1, scope: "session", family: true,
  initial: () => ({}), checkpointWhen: () => true,
});
const CapturedOutput = defineDoc<{ result?: ExecutionResult }>({
  kind: "camel.host-output", version: 1, scope: "task", initial: () => ({}), checkpointWhen: () => false,
});
const HostExecutionRequest = defineDoc<{ requestId?: string }>({
  kind: "camel.host-request", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({}), checkpointWhen: () => true,
});

/** Nested tool effects use the ownerless script conversation, independent of concurrent model runs. */
export async function hostExecutionRequest(pi: Harness, conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<string | undefined> {
  return (await pi.snapshot(HostExecutionRequest, conversationId, context))?.requestId;
}

export function executionParams(value: unknown): Required<ExecutionParams> {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["code", "timeoutMs", "maxOutputCharacters"].includes(key))) throw new Error("Invalid execute parameters");
  if (typeof input.code !== "string" || input.code.length > 1_000_000) throw new Error("code must be a string of at most 1000000 characters");
  const timeoutMs = input.timeoutMs ?? SANDBOX_LIMITS.timeoutMs, maxOutputCharacters = input.maxOutputCharacters ?? SANDBOX_LIMITS.outputCharacters;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1) throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(maxOutputCharacters) || Number(maxOutputCharacters) < 1 || Number(maxOutputCharacters) > 128_000) throw new Error("maxOutputCharacters must be between 1 and 128000");
  return { code: input.code, timeoutMs: Math.min(Number(timeoutMs), SANDBOX_LIMITS.maxTimeoutMs), maxOutputCharacters: Number(maxOutputCharacters) };
}

export function executionOutput(raw: CodemodeResult, max: number): ExecutionResult {
  let remaining = max, truncated = false;
  const values = raw.output.map(item => item.type === "text" ? item.text : `[image ${item.mimeType}]`);
  if (raw.ok && raw.value !== undefined) values.push(typeof raw.value === "string" ? raw.value : JSON.stringify(raw.value));
  const output = values.map(value => {
    const kept = value.slice(0, remaining);
    remaining -= kept.length;
    truncated ||= kept.length !== value.length;
    return kept;
  }).filter(Boolean);
  return { output, truncated, ...(!raw.ok ? { error: { kind: raw.error.kind, message: raw.error.message, ...(raw.error.name ? { name: raw.error.name } : {}) } } : {}) };
}

/** Keep Pi's replay journal and tool policy, but capture the raw SDK result before its model-facing formatting. */
export function hostExecutionTool(sandbox: CodemodeSandboxBase): ToolRegistration {
  return {
    name: HOST_EXECUTION_TOOL, description: "Execute a host SDK script outside agent history.",
    parameters: { type: "object", required: ["code"], properties: { code: { type: "string" }, timeoutMs: { type: "integer" }, maxOutputCharacters: { type: "integer" } }, additionalProperties: false },
    callers: ["model"], replay: "safe", outputLimits: { maxBytes: 512_000, maxLines: 128_000 },
    async execute(input, api, context) {
      const params = executionParams(input);
      class CapturingSandbox extends CodemodeSandboxBase {
        constructor() { super({}, () => { throw new Error("The host sandbox only supports durable runs"); }); }
        override start(code: string, options: CodemodeRunOptions) {
          const run = sandbox.start(code, options);
          return {
            get finished() { return run.finished; },
            deliver: run.deliver.bind(run),
            result: run.result.then(async raw => {
              await api.commit(async tx => { (await tx.doc(CapturedOutput, api.taskId)).result = executionOutput(raw, params.maxOutputCharacters); }, context);
              return raw;
            }),
          };
        }
      }
      const native = createCodemodeTool({ sandbox: new CapturingSandbox(), models: false });
      const code = `// @options: ${JSON.stringify({ timeout_ms: params.timeoutMs, max_output_tokens: 128_000 })}\n${params.code}`;
      const result = await native.execute({ code }, api, context);
      const captured = await api.snapshot(CapturedOutput, api.taskId, context);
      return { ...result, details: { ...(result.details as Record<string, unknown> ?? {}), ...(captured?.result ? { hostExecution: captured.result } : {}) } };
    },
  };
}

/** Admission and the task ID commit together. Repeated HTTP deliveries join the same task. */
export async function startHostExecution(pi: Harness, root: Conversation, requestId: string, value: unknown, tool: ToolRegistration, context: Context = BACKGROUND_CONTEXT) {
  const params = executionParams(value), fingerprint = JSON.stringify(params), agent = await root.agent(context);
  return pi.commit(async tx => {
    const saved = await tx.doc(Executions, requestId, null);
    if (saved.fingerprint !== undefined && saved.fingerprint !== fingerprint) throw Object.assign(new Error("Request id reused with different input"), { status: 409 });
    if (saved.task !== undefined) return saved.task as TaskId<ToolTaskResult>;
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    (await tx.doc(HostExecutionRequest, conversation.id)).requestId = requestId;
    await configure(tx, conversation.id, { extensions: agent.extensions, tools: [...agent.callable, tool], modelTools: [tool] });
    const callId = `execute:${requestId}`;
    const assistant = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{
      role: "assistant", api: "openai-completions", provider: "camelrun", model: "host-execution", stopReason: "toolUse", timestamp: Date.now(),
      content: [{ type: "toolCall", id: callId, name: HOST_EXECUTION_TOOL, arguments: params }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }] });
    const task = await tx.createTask(ToolTask, { kind: "model", assistant: assistant.id, callId }, { ownership: { kind: "conversation" }, conversationId: conversation.id });
    saved.fingerprint = fingerprint; saved.task = task;
    return task;
  }, context);
}

export async function waitHostExecution(pi: Harness, task: TaskId<ToolTaskResult>, context: Context = BACKGROUND_CONTEXT): Promise<ExecutionResult & { diagnostics?: unknown[] }> {
  const settled = await pi.waitForTask(task, context), outcome = settled.state.outcome;
  const result = "result" in outcome ? outcome.result : undefined;
  if (result?.kind === "model") {
    const entry = await pi.commit(tx => tx.entry(ToolResultEntry, result.entryId), context), message = entry?.model?.[0];
    if (message?.role === "toolResult") {
      const captured = (message.details as { hostExecution?: ExecutionResult } | undefined)?.hostExecution;
      if (captured) return { ...captured, diagnostics: entry?.data?.diagnostics ?? [] };
      return { output: [], truncated: false, error: { kind: outcome.status === "aborted" ? "aborted" : "sandbox", message: message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") }, diagnostics: entry?.data?.diagnostics ?? [] };
    }
  }
  return { output: [], truncated: false, error: { kind: outcome.status === "aborted" ? "aborted" : "sandbox", message: "error" in outcome && outcome.error ? outcome.error.message : `Execution ${outcome.status}` } };
}

export async function abortHostExecution(pi: Harness, requestId: string, context: Context = BACKGROUND_CONTEXT) {
  const saved = await pi.snapshot(Executions, requestId, context);
  if (saved?.task !== undefined) await pi.abortTask(saved.task as TaskId, context);
}
