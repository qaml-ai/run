/** The host can describe usage, but never chooses the tenant, key owner or billing policy. */
export type ModelAttemptEvent =
  | { type: "begin"; id: string; provider: string; model: string; kind: "response" | "compaction"; at: number; keyHash: string; context?: Pick<import("./client-sessions.ts").UsageRecord, "requestId" | "actor" | "identity" | "keyScope"> }
  | { type: "generation"; id: string; generation: string }
  | { type: "finish"; id: string; usage: Record<string, any>; chars: number; completed: boolean };
export type ModelAttemptHook = (event: ModelAttemptEvent) => Promise<boolean>;
