import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { McpResult } from "./attached-tools.ts";
import { approver, inputRequests, resolution, type InputRow } from "./input-policy.ts";
import { HumanInputs, humanInputView, waitForHuman, type HumanInput } from "./human.ts";

export type ToolInputReply = {
  inputResponses?: Record<string, unknown>; requestState?: string;
  approval?: { input: string; by: Record<string, unknown>; at: number };
  /** Runtime-only note, appended to the result and never sent as an MCP argument. */
  note?: string;
};

/** Share source approval/elicitation resolution, including proof and decline explanations. */
export function resolveToolInputs(inputs: { id: string; input: HumanInput; key?: string }[], requestState?: string): { result: McpResult } | { reply: ToolInputReply } {
  const rows = inputs.map(({ id, input, key }): InputRow => ({
    ...humanInputView(id, input, "", input.requestId), tenant: "", kind: input.kind ?? "question",
    state: input.state ?? "answered", answer: input.answerDetail,
    stored: { message: input.question, detail: input.detail ?? {}, responders: input.responders ?? {}, tool: String(input.detail?.tool ?? ""), argumentsHash: "", ...(key ? { key } : {}) },
  }));
  const answer = resolution(rows, () => requestState);
  if ("result" in answer) return answer;
  const { argumentsHash: _hash, ...reply } = answer.retry;
  return { reply: { ...reply, ...(reply.approval ? { approval: { ...reply.approval, by: approver(reply.approval.by) } } : {}) } };
}

export function withInputNote(result: McpResult, reply: ToolInputReply): McpResult {
  if (!reply.note) return result;
  // Keep the tool's data separate from the runtime's annotation for code callers.
  let data = result.structuredContent;
  const content = result.content ?? [];
  if (data === undefined && content.length === 1 && (content[0] as { type?: string }).type === "text") {
    const text = String((content[0] as { text?: string }).text ?? "");
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ...result, ...(data !== undefined ? { structuredContent: data } : {}), content: [...content, { type: "text", text: reply.note }] };
}

/** An MCP server's elicitation is a durable human wait, followed by the same keyed call. */
export async function withToolInputs(call: (reply: ToolInputReply) => Promise<McpResult>, api: ToolExecutionApi, context: Context, tool?: { name: string; args: unknown }, initial: ToolInputReply = {}) {
  let reply: ToolInputReply = initial;
  for (let round = 0; round < 32; round++) {
    const result = await call(reply);
    if (result.resultType !== "input_required") return withInputNote(result, reply);
    const requests = inputRequests(result);
    // Commit all requests before waiting, so the caller can answer a batch atomically.
    await Promise.all(requests.map(async request => {
      const suffix = `mcp:${round}:${request.key}`;
      const detail = { ...request.detail, ...(tool && request.kind === "approval" ? { tool: tool.name, source: tool.name.includes("__") ? tool.name.split("__")[0] : "application", arguments: tool.args } : {}) };
      await waitForHuman({ kind: request.kind, question: request.message || `Allow ${tool?.name ?? "this tool"} to run?`, detail }, api, context, suffix);
    }));
    const saved = (await api.snapshot(HumanInputs, context))!;
    const resolved = resolveToolInputs(requests.map(request => {
      const id = `${api.taskId}:mcp:${round}:${request.key}`;
      return { id, input: saved.requests[id], key: request.key };
    }), typeof result.requestState === "string" ? result.requestState : undefined);
    if ("result" in resolved) return resolved.result;
    reply = { ...reply, ...resolved.reply };
  }
  throw new Error("Tool exceeded 32 human input rounds");
}
