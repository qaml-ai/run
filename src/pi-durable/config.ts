/** Operator setting; tenants keep the same session and request API. */
export type AgentEngine = "legacy" | "pi-durable";

export function agentEngine(value: string | undefined): AgentEngine {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "pi-durable") return value;
  throw new Error("AGENT_ENGINE must be legacy or pi-durable");
}
