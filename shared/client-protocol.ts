export const FRAME_BYTES = 1_100_000;
/** `uncertain` marks an outcome nobody can confirm (timeout after claim, restart). It is informational, never a gate. */
export type Outcome = { result: unknown; error?: never; uncertain?: never } | { error: string; uncertain?: boolean; result?: never };
/** How an outcome ended: its error, the runtime's or the model's (`result.error`), and why its turn stopped early. */
export function outcomeEnding(outcome: Outcome | undefined): { error?: string; stopped?: "input_required" | "spend_limit" } {
  const result = (outcome?.result ?? {}) as { error?: unknown; stopped?: unknown };
  const error = outcome?.error ?? (typeof result.error === "string" ? result.error : undefined);
  const stopped = result.stopped === "input_required" || result.stopped === "spend_limit" ? result.stopped : undefined;
  return { ...(error !== undefined ? { error } : {}), ...(stopped ? { stopped } : {}) };
}
/** `expiresAt` is null for agents that live until deleted. */
export interface SessionCredentials { id: string; token: string; expiresAt: number | null }
export type RequestMethod = "prompt" | "execute" | "status" | "abort" | "continue" | "steer" | "configure" | "resume";
export type RequestRecord = {
  id: string; startedAt?: number; endedAt?: number; prompt?: string; code?: string; fingerprint: string; method: RequestMethod;
  /** "running" covers queued runs too: a run has begun once `began` is set. */
  state: "running" | "completed"; outcome?: Outcome;
  /** An ended request's error, from `outcome`: the runtime's, or the model's (`outcome.result.error`). Absent when it succeeded. */
  error?: string;
  /** Why an ended run stopped early, from `outcome.result.stopped`. */
  stopped?: "input_required" | "spend_limit";
  /** When the agent actually started this run (runs queue behind each other). */
  began?: number;
  /** Kept until the run begins, so a queued run survives a restart and runs exactly once. */
  params?: unknown;
  /** Times a new owner resumed this run's turn after the node running it was lost. */
  resumes?: number;
  /** Who the application said is acting in this run: passed to its tool calls (`act` in identity tokens). */
  actor?: string;
  /** A `resume` run's suspension: the run whose turn waited on human input, which this one continues. */
  suspension?: string;
  /** The application's key-value data sent with a message (prompt, steer), also kept on the message. */
  metadata?: Record<string, string>;
  /** A prompt sent with `whileRunning: "steer"` that a running turn took: that turn's request, whose outcome it shares. */
  steeredInto?: string;
  /** The runtime's own: an ended run whose webhook event (`run.completed` or `run.failed`) is not written yet. */
  announce?: true;
};
/**
 * Events on an agent's stream. `mcp` carries the runtime's JSON-RPC messages to the application's attached MCP server: live only, with no id, never replayed.
 * `snapshot` goes only to subscribers that ask for one (`?snapshot=1`), in place of what they cannot replay: the running turn as of its id.
 */
export type ClientEvent =
  | { type: "event"; requestId: string; event: any }
  | { type: "response"; id: string; outcome: Outcome }
  | { type: "mcp"; message: Record<string, unknown> }
  | TurnSnapshot;
/**
 * The agent's running turn as a subscriber that saw every event since the turn began would have it: the messages its run
 * finished (every `message_end`, in order) and the assistant message still streaming. `turn` is null when no turn runs.
 * `truncated`: the turn's messages were too large to send; read them from history. `start` is the index its first message
 * has in the agent's history, and `count` how many it finished (sent or not): the next takes `start + count`.
 */
export type TurnSnapshot = {
  type: "snapshot"; cursor: number; requestId: string | null;
  turn: { start: number | null; count: number; messages: unknown[]; partial: unknown | null; truncated?: true } | null;
};
export type SessionState = { cursor: number; requests: RequestRecord[] };
/** A tool an application offers its agent; shared by the SDKs and the runtime. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
  /** The user approves each call before it runs (a source's approval policy, or the tool's own needsApproval); such a tool is declared directly. */
  needsApproval?: boolean;
  /** How long a call may go without an answer or progress (ms): the tool's `_meta["agent-runtime/timeoutMs"]`. */
  timeoutMs?: number;
}
