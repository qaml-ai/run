/** Internal subclass capability. Symbols cannot be addressed by Durable Object RPC. */
export const ARM_AGENT = Symbol("camelRun.armAgent");
/** Bring pending human inputs' expiry forward (the local contract fixture's due inputs). */
export const DUE_HUMAN_INPUTS = Symbol("camelRun.dueHumanInputs");

/** Local fixtures can inspect a runtime without adding anything to the DO's RPC surface. */
export const testAgentRuntimes = new WeakMap<object, import("./agent-runtime.ts").AgentRuntime>();
