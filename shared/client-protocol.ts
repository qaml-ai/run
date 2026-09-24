export const FRAME_BYTES = 1_100_000;
/** `uncertain` marks an outcome nobody can confirm (timeout after claim, restart). It is informational, never a gate. */
export type Outcome = { result: unknown; error?: never; uncertain?: never } | { error: string; uncertain?: boolean; result?: never };
/** `expiresAt` is null for agents that live until deleted. */
export interface SessionCredentials { id: string; token: string; expiresAt: number | null }
export type RequestMethod = "prompt" | "execute" | "status" | "abort" | "history" | "continue" | "steer" | "followUp" | "configure";
export type CallRecord = {
  id: string; toolCallId?: string; requestId?: string; createdAt?: number; name: string; args: Record<string, unknown>; deadline: number;
  /**
   * `started`: delivered to the application, which runs it at most once. `uncertain`: delivered,
   * but the outcome was lost; the model was told it is unknown. `offered` is only in older journals.
   */
  state: "offered" | "started" | "completed" | "cancelled" | "uncertain";
  outcome?: Outcome;
  /** A result that arrived after the call was already settled as uncertain. */
  lateOutcome?: Outcome;
  /** The client (`X-Agent-Client` on its event stream) the call was delivered to: only it runs the call. */
  client?: string;
  /** Where the turn came from, set by the runtime (e.g. a channel and its sender), so tools can authorize. */
  origin?: Record<string, unknown>;
};
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
export type ClientEvent =
  | { type: "tool_call"; call: CallRecord }
  | { type: "tool_cancel"; id: string }
  | { type: "event"; requestId: string; event: any }
  | { type: "response"; id: string; outcome: Outcome };
export type SessionState = { cursor: number; calls: CallRecord[]; requests: RequestRecord[] };
/** A tool an application offers its agent; shared by the SDKs and the runtime. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
}
