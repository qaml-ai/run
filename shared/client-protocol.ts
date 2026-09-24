export const FRAME_BYTES = 1_100_000;
/** `uncertain` marks an outcome nobody can confirm (timeout after claim, restart). It is informational, never a gate. */
export type Outcome = { result: unknown; error?: never; uncertain?: never } | { error: string; uncertain?: boolean; result?: never };
/** `expiresAt` is null for agents that live until deleted. */
export interface SessionCredentials { id: string; token: string; expiresAt: number | null }
export type RequestMethod = "prompt" | "execute" | "status" | "abort" | "history" | "continue" | "steer" | "followUp" | "configure";
export type RequestRecord = {
  id: string; startedAt?: number; endedAt?: number; prompt?: string; code?: string; fingerprint: string; method: RequestMethod;
  /** "running" covers queued runs too: a run has begun once `began` is set. */
  state: "running" | "completed"; outcome?: Outcome;
  /** When the agent actually started this run (runs queue behind each other). */
  began?: number;
  /** Kept until the run begins, so a queued run survives a restart and runs exactly once. */
  params?: unknown;
  /** Times a new owner resumed this run's turn after the node running it was lost. */
  resumes?: number;
};
/** Events on an agent's stream. `mcp` carries the runtime's JSON-RPC messages to the application's attached MCP server: live only, with no id, never replayed. */
export type ClientEvent =
  | { type: "event"; requestId: string; event: any }
  | { type: "response"; id: string; outcome: Outcome }
  | { type: "mcp"; message: Record<string, unknown> };
export type SessionState = { cursor: number; requests: RequestRecord[] };
/** A tool an application offers its agent; shared by the SDKs and the runtime. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
}
