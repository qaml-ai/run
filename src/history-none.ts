/** Agents (with the source) whose `history: "none"` this process has logged: once each, to find callers still sending it. */
const logged = new Set<string>();

/**
 * `history: "none"` (a prompt's, or a schedule's) is accepted and ignored: every run sees the agent's history, which Pi's
 * compaction bounds; a run that needs none is POST /v1/runs.
 */
export function historyNoneIgnored(agent: string, tenant: string, source: "prompt" | "schedule") {
  if (logged.has(`${source} ${agent}`)) return;
  logged.add(`${source} ${agent}`);
  console.log(JSON.stringify({ type: "history_none_ignored", agent, tenant, source }));
}
