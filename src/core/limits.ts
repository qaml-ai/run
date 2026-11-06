/** Limits the shared policy reads; src/limits.ts re-exports them with the rest. */

/** Files through tool calls (tool-files.ts): arguments that name a file, and outputs saved to the workspace. */
export const TOOL_FILE_LIMITS = Object.freeze({
  /** A file sent as base64 in a tool's arguments. */
  inlineBytes: 4 * 1024 * 1024,
  /** A binary response (an OpenAPI operation's, web_fetch's), saved rather than shown. */
  responseBytes: 64 * 1024 * 1024,
  /** An MCP text resource longer than this is saved rather than shown. */
  textBytes: 64 * 1024,
  /** What one tool call, and all the calls of one run, may save. */
  callBytes: 64 * 1024 * 1024, runBytes: 256 * 1024 * 1024,
  /** A call-bound file URL's lifetime, in seconds; a directory's snapshot is kept this long after its call ends. */
  urlSeconds: 5 * 60,
  /** A directory sent to a tool: its files, and their bytes. */
  directoryFiles: 1000, directoryBytes: 256 * 1024 * 1024,
  /** Files up to this size carry a sha-256 digest (each is read to compute it). */
  digestBytes: 64 * 1024 * 1024,
});

/**
 * A judged call (tool-judge.ts): what the decision model is shown of the request and the call, cut so one call cannot
 * hold the runtime's thread or bill a tenant for a document, and how long a judge may take before the call asks a person.
 */
export const JUDGE_LIMITS = Object.freeze({
  /** What the judge is shown of the request: its start and its end, since a condition can come last. */
  intentChars: 2_000, intentTailChars: 500,
  /** A source's description is capped at 4,000 on the model's side too (tool-sources), so nothing is hidden from the judge. */
  descriptionChars: 4_000, argumentsChars: 8_000,
  /** One judged call's deadline, waits for a decision slot included (a Jev call answers in 70–500 ms). */
  timeoutMs: 15_000,
});

/**
 * Decisions (decisions.ts): typed questions about one state, answered by a decision model. A request asks about one state
 * or a batch of `items`; each item is one provider call. Characters, not tokens, so the arithmetic is the same for every
 * provider (Jev takes about 32k tokens of state and question, which `itemChars` stays well under).
 */
export const DECISION_LIMITS = Object.freeze({
  items: 100, questions: 32, idChars: 64, instructionChars: 4_000, criterionChars: 1_000, choices: 255, levels: 10,
  stateChars: 64_000, itemChars: 96_000,
  /** A request's JSON body (a batch's states are about 20,000 characters each at most). */
  requestBytes: 2 * 1024 * 1024,
  /**
   * Provider calls at once: a tenant's on one node (by default: a tenant's own, its tier's, override it), and the
   * node's (AGENT_DECISION_NODE_CONCURRENCY; the outbound pool keeps 64 connections an origin, so more would wait
   * there); past them calls wait, at most `queued` a tenant. A tenant's queue and characters scale with its concurrency.
   */
  tenantConcurrent: 16, nodeConcurrent: 64, queued: 1_000,
  /** Characters of state and question held by requests in flight on a node: a tenant's, and all of them (then 429). */
  tenantChars: 8_000_000, nodeChars: 32_000_000,
  /** A request whose calls waited this long for a slot logs `decision_wait`. */
  waitLogMs: 250,
  /** Attempts of a call a provider failed for now (rate limited, overloaded, 5xx), backing off from `backoffMs`. */
  attempts: 3, backoffMs: 250,
  /** One provider call (Jev answers in 70–500 ms), and a whole request with its waits and retries. */
  callTimeoutMs: 10_000, requestTimeoutMs: 60_000,
});
