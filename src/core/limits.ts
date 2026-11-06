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
