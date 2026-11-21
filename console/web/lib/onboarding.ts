import { useApi, type AgentSummary, type ApiToken, type UsageResponse } from "@/lib/api";

export type Start = "code";

export const startFrom = (search: string): Start | undefined => {
  const start = new URLSearchParams(search).get("start");
  return start === "code" ? start : undefined;
};

/** Home (/console/) is Get started for an account with no agents (or `?start=code`), else Overview. */
export const homeIsGetStarted = (search: string, agents: number | undefined) => !!startFrom(search) || agents === 0;

export const startNext = (pathname: string, search: string) => {
  const start = startFrom(search);
  return start && /^\/console\/(start)?$/.test(pathname) ? `/console/?start=${start}` : undefined;
};

/** The playground's agent key: one per account via PUT /v2/agents/playground. */
export const PLAYGROUND_KEY = "playground";

export interface Step {
  id: string;
  label: string;
  done: boolean;
}

export function codeSteps({
  tokens,
  agents,
  usage,
}: {
  tokens?: ApiToken[];
  agents?: AgentSummary[];
  usage?: UsageResponse;
}): Step[] {
  const ran = (usage?.days ?? []).some(row => row.responses > 0);
  return [
    { id: "try", label: "Try an agent right here", done: !!agents?.length && ran },
    { id: "key", label: "Create an API key", done: !!tokens?.length },
    { id: "code", label: "Run an agent from code", done: ran && !!agents?.some(agent => agent.key !== PLAYGROUND_KEY) },
  ];
}

export const complete = (steps: Step[]) => steps.every(step => step.done);

export function useOnboarding(poll?: number) {
  const tokens = useApi<{ tokens: ApiToken[] }>("/v2/tokens", poll);
  const agents = useApi<{ agents: AgentSummary[] }>("/v2/agents", poll);
  const usage = useApi<UsageResponse>("/v2/usage?days=90", poll);
  const tokenList = tokens.data?.tokens;
  const agentList = agents.data?.agents;
  const code = codeSteps({ tokens: tokenList, agents: agentList, usage: usage.data });
  const loaded = !!tokenList && !!agentList && !!usage.data;
  return { tokens, agents, usage, tokenList, agentList, code, loaded };
}

export function navProgress(onboarding: ReturnType<typeof useOnboarding>, _open?: Start) {
  const code = onboarding.code;
  return {
    done: code.filter(step => step.done).length,
    total: code.length,
    complete: onboarding.loaded && complete(code),
  };
}
