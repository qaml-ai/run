import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { McpResult } from "./attached-tools.ts";
import { inputRequests } from "./input-policy.ts";
import { HumanInputs, waitForHuman } from "./human.ts";

export type ToolInputReply = {
  inputResponses?: Record<string, unknown>; requestState?: string;
  approval?: { input: string; by: Record<string, unknown>; at: number };
};

/** An MCP server's elicitation is a durable human wait, followed by the same keyed call. */
export async function withToolInputs(call: (reply: ToolInputReply) => Promise<McpResult>, api: ToolExecutionApi, context: Context, tool?: { name: string; args: unknown }) {
  let reply: ToolInputReply = {};
  for (let round = 0; round < 32; round++) {
    const result = await call(reply);
    if (result.resultType !== "input_required") return result;
    const responses: Record<string, unknown> = {};
    for (const request of inputRequests(result)) {
      const suffix = `mcp:${round}:${request.key}`, id = `${api.taskId}:${suffix}`;
      const detail = { ...request.detail, ...(tool ? { tool: tool.name, arguments: tool.args } : {}) };
      const answer = await waitForHuman({ kind: request.kind, question: request.message || `Allow ${tool?.name ?? "this tool"} to run?`, detail }, api, context, suffix);
      const saved = (await api.snapshot(HumanInputs, context))?.requests[id];
      const content = JSON.parse(answer.output[0].text);
      const action = saved?.state === "declined" ? "decline" : saved?.state === "cancelled" ? "cancel" : "accept";
      responses[request.key] = { action, ...(action === "accept" && request.kind !== "approval" && request.kind !== "url" ? { content } : {}) };
      if (request.kind === "approval" && action === "accept") reply.approval = { input: id, by: saved?.answerDetail?.by ?? {}, at: saved?.answerDetail?.at ?? api.now() };
      if (request.kind === "approval" && action !== "accept") return { content: [{ type: "text", text: "Tool approval declined" }], isError: true };
    }
    reply = { ...reply, inputResponses: responses, ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}) };
  }
  throw new Error("Tool exceeded 32 human input rounds");
}
