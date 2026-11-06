import { useApi, type AgentSummary, type ApiToken, type Usage } from "@/lib/api";

/** The use-case starts Get started offers; `?start=` on /console/ opens one (a landing page's deep link). */
export type Start = "code";
export const startFrom = (search: string): Start | undefined => {
  const start = new URLSearchParams(search).get("start");
  return start === "code" ? start : undefined;
};

/** Whether home (/console/) is Get started: a use-case start's deep link, or an account with no agent yet. Else Overview. */
export const homeIsGetStarted = (search: string, agents: number | undefined) => !!startFrom(search) || agents === 0;

/** Where sign-in returns a deep link to: only /console/?start=<a start>, which the server's sign-in also accepts. */
export const startNext = (pathname: string, search: string) => {
  const start = startFrom(search);
  return start && /^\/console\/(start)?$/.test(pathname) ? `/console/?start=${start}` : undefined;
};

/** The playground's agent: one per account, made with this Idempotency-Key. */
export const PLAYGROUND_KEY = "playground";

export interface Step { id: string; label: string; done: boolean }

/** The code path's three cards, from what the account has: a run here, an API key, an agent of your own code that ran. */
export function codeSteps({ tokens, agents, usage }: { tokens?: ApiToken[]; agents?: AgentSummary[]; usage?: Usage }): Step[] {
  const ran = (usage?.totals.responses ?? 0) > 0;
  return [
    { id: "try", label: "Try an agent right here", done: !!agents?.length && ran },
    { id: "key", label: "Create an API key", done: !!tokens?.length },
    { id: "code", label: "Run an agent with your own tool", done: ran && !!agents?.some(agent => agent.key !== PLAYGROUND_KEY) },
  ];
}

export const complete = (steps: Step[]) => steps.every(step => step.done);

/**
 * What the checklists read: existing endpoints only. `poll` while Get started is open, so a script run in a terminal
 * ticks its step without a reload; elsewhere one read, for the nav's progress.
 */
export function useOnboarding(poll?: number) {
  const tokens = useApi<ApiToken[]>("/v1/tokens", poll);
  const agents = useApi<AgentSummary[]>("/v1/agents", poll);
  const usage = useApi<Usage>("/v1/usage?days=90", poll);
  const code = codeSteps({ tokens: tokens.data, agents: agents.data, usage: usage.data });
  const loaded = !!tokens.data && !!agents.data && !!usage.data;
  return { tokens, agents, usage, code, loaded };
}

/** Get started stays in the nav, with its progress, until the code path is done. */
export function navProgress(onboarding: ReturnType<typeof useOnboarding>, _open?: Start) {
  const code = onboarding.code;
  return { done: code.filter(step => step.done).length, total: code.length, complete: onboarding.loaded && complete(code) };
}
