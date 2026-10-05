import { useApi, type AgentSummary, type ApiToken, type Definition, type ManagedDiscordBinding, type ManagedDiscordConfig, type Usage } from "@/lib/api";

/** The use-case starts Get started offers; `?start=` on /console/ opens one (a landing page's deep link). */
export type Start = "discord" | "code";
export const startFrom = (search: string): Start | undefined => {
  const start = new URLSearchParams(search).get("start");
  return start === "discord" || start === "code" ? start : undefined;
};

/** Where sign-in returns a deep link to: only /console/?start=<a start>, which the server's sign-in also accepts. */
export const startNext = (pathname: string, search: string) => {
  const start = startFrom(search);
  return start && /^\/console\/(start)?$/.test(pathname) ? `/console/?start=${start}` : undefined;
};

/** The playground's agent: one per account, made with this Idempotency-Key. */
export const PLAYGROUND_KEY = "playground";
/** Definitions a Discord starter makes are named with this, so the path finds the one it made. */
export const DISCORD_STARTER_PREFIX = "Discord: ";

export interface Step { id: string; label: string; done: boolean }

/** The code path's three cards, from what the account has: a run here, an API key, an agent of your own code that ran. */
export function codeSteps({ tokens, agents, usage }: { tokens?: ApiToken[]; agents?: AgentSummary[]; usage?: Usage }): Step[] {
  const ran = (usage?.totals.responses ?? 0) > 0;
  return [
    { id: "try", label: "Run an agent here", done: !!agents?.length && ran },
    { id: "key", label: "Create an API key", done: !!tokens?.length },
    { id: "code", label: "Run one from your code", done: ran && !!agents?.some(agent => agent.key !== PLAYGROUND_KEY) },
  ];
}

/** The server the Discord path is about: the one just added, else the account's first. */
export function discordServer(bindings: ManagedDiscordBinding[] | undefined, chosen?: string) {
  return bindings?.find(binding => binding.guildId === chosen) ?? bindings?.find(binding => binding.state !== "disconnected") ?? bindings?.[0];
}

/** A conversation in a managed Discord server is an agent keyed `discord-managed-<channel>-<conversation>`: its first means Camel was mentioned. */
export const repliedIn = (agents: AgentSummary[] | undefined, channelId: string | null | undefined) =>
  !!channelId && !!agents?.some(agent => agent.key?.startsWith(`discord-managed-${channelId}-`));

/** The Discord path: a starter, Camel in a server, its setup, a first mention. */
export function discordSteps({ definitions, server, agents }: { definitions?: Definition[]; server?: ManagedDiscordBinding; agents?: AgentSummary[] }): Step[] {
  const ready = !!server?.channel && server.state === "active";
  return [
    { id: "starter", label: "Pick a starter bot", done: !!server?.channel || !!definitions?.some(definition => definition.name.startsWith(DISCORD_STARTER_PREFIX)) },
    { id: "added", label: "Add Camel to your server", done: !!server },
    { id: "setup", label: "Choose its channels", done: ready },
    { id: "hello", label: "Say hello with an @mention", done: ready && repliedIn(agents, server?.channelId) },
  ];
}

export const complete = (steps: Step[]) => steps.every(step => step.done);

/**
 * What the checklists read: existing endpoints only. `poll` while Get started is open, so a script run in a terminal or a
 * mention in Discord ticks its step without a reload; elsewhere one read, for the nav's progress.
 */
export function useOnboarding(poll?: number) {
  const tokens = useApi<ApiToken[]>("/v1/tokens", poll);
  const agents = useApi<AgentSummary[]>("/v1/agents", poll);
  const usage = useApi<Usage>("/v1/usage?days=90", poll);
  const discord = useApi<ManagedDiscordConfig>("/console/discord/config");
  const bindings = useApi<{ bindings: ManagedDiscordBinding[] }>(discord.data?.enabled ? "/console/discord/bindings" : undefined, poll);
  const definitions = useApi<Definition[]>("/v1/definitions", poll);
  const code = codeSteps({ tokens: tokens.data, agents: agents.data, usage: usage.data });
  const loaded = !!tokens.data && !!agents.data && !!usage.data;
  return { tokens, agents, usage, discord, bindings, definitions, code, loaded };
}

/** Get started stays in the nav, with its progress, until either path is done. */
export function navProgress(onboarding: ReturnType<typeof useOnboarding>) {
  const server = discordServer(onboarding.bindings.data?.bindings);
  const discord = discordSteps({ definitions: onboarding.definitions.data, server, agents: onboarding.agents.data });
  const code = onboarding.code;
  const best = code.filter(step => step.done).length / code.length >= discord.filter(step => step.done).length / discord.length ? code : discord;
  return { done: best.filter(step => step.done).length, total: best.length, complete: onboarding.loaded && (complete(code) || complete(discord)) };
}
