import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, ApiToken, Definition, ManagedDiscordBinding, Usage } from "../web/lib/api";
import { groupOf, NAV, TABS } from "../web/lib/nav";
import { codeSteps, discordSteps, navProgress, startFrom, startNext, type useOnboarding } from "../web/lib/onboarding";
import { ManagedDiscordDialog } from "../web/pages/discord-managed";
import { GetStartedPage } from "../web/pages/start";
import { PLAYGROUND_PROMPT, snippets } from "../web/pages/start-code";
import { ONBOARDING_LIMITS } from "../web/pages/start-discord";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const agent = (fields: Partial<AgentSummary> = {}): AgentSummary => ({ id: "client_1", name: "a", type: "general", model: "m", connected: false, running: false, expiresAt: null, key: null, ...fields });
const usage = (responses: number) => ({ since: 0, totals: { responses, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, days: [] }) as Usage;
const token: ApiToken = { id: "t1", name: "k", prefix: "art_1234", createdAt: 1 };
const server = (fields: Partial<ManagedDiscordBinding> = {}): ManagedDiscordBinding => ({
  guildId: "101", guildName: "My server", state: "paused", installationState: "present", channelId: null, allowedChannelIds: [], ...fields,
});
const live = server({ state: "active", channelId: "ch1", allowedChannelIds: ["555"], channel: { id: "ch1", type: "discord-managed", name: "Camel", definition: "d1", access: { public: true, allow: [] }, limits: { perSenderPerMinute: 3, turnsPerDay: 50 }, account: {}, credentials: {}, createdAt: 1 } });
const starter: Definition = { id: "d1", name: "Discord: Server assistant", revision: 1, createdAt: 1, updatedAt: 1 };

/** What useOnboarding returns, from plain data. */
function onboarding({ tokens = [], agents = [], responses = 0, discord = true, bindings = [], definitions = [] }: {
  tokens?: ApiToken[]; agents?: AgentSummary[]; responses?: number; discord?: boolean; bindings?: ManagedDiscordBinding[]; definitions?: Definition[];
} = {}): ReturnType<typeof useOnboarding> {
  const state = <T,>(data: T) => ({ data, error: undefined, loading: false, reload: vi.fn(async () => {}) });
  return {
    tokens: state(tokens), agents: state(agents), usage: state(usage(responses)), discord: state({ enabled: discord, applicationId: "999", installPath: "/console/discord/install" }),
    bindings: state({ bindings }), definitions: state(definitions), code: codeSteps({ tokens, agents, usage: usage(responses) }), loaded: true,
  };
}

let calls: { path: string; method: string; body?: any; headers: Record<string, string> }[];
let respond: (path: string, method: string, body: any) => Response | undefined;
beforeEach(() => {
  calls = []; respond = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: init.headers as Record<string, string> });
    return respond(path, method, body) ?? json(path.startsWith("/console/discord/guilds") ? { channels: [{ id: "555", name: "general", type: 0 }] } : []);
  }));
  history.replaceState(null, "", "/console/");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("checklists", () => {
  it("tick the code path off from tokens, agents and usage", () => {
    expect(codeSteps({}).map(step => step.done)).toEqual([false, false, false]);
    expect(codeSteps({ tokens: [token], agents: [], usage: usage(0) }).map(step => step.done)).toEqual([false, true, false]);
    // The playground's run is card 1; card 3 needs an agent of the user's own code.
    expect(codeSteps({ agents: [agent({ key: "playground" })], usage: usage(1) }).map(step => step.done)).toEqual([true, false, false]);
    expect(codeSteps({}).map(step => step.label)).toEqual(["Try an agent right here", "Create an API key", "Run an agent with your own tool"]);
    expect(codeSteps({ tokens: [token], agents: [agent({ key: "playground" }), agent({ key: "quickstart" })], usage: usage(2) }).map(step => step.done)).toEqual([true, true, true]);
  });

  it("tick the Discord path off from a starter, the server, its setup and its first conversation", () => {
    expect(discordSteps({}).map(step => step.done)).toEqual([false, false, false, false]);
    expect(discordSteps({ definitions: [starter] }).map(step => step.done)).toEqual([true, false, false, false]);
    expect(discordSteps({ definitions: [starter], server: server() }).map(step => step.done)).toEqual([true, true, false, false]);
    expect(discordSteps({ definitions: [starter], server: live, agents: [agent({ key: "playground" })] }).map(step => step.done)).toEqual([true, true, true, false]);
    // Another channel's conversation is not this server's.
    expect(discordSteps({ server: live, agents: [agent({ key: "discord-managed-ch2-x" })] })[3].done).toBe(false);
    expect(discordSteps({ server: live, agents: [agent({ key: "discord-managed-ch1-555" })] }).map(step => step.done)).toEqual([true, true, true, true]);
    expect(discordSteps({ server: { ...live, state: "paused" }, agents: [agent({ key: "discord-managed-ch1-555" })] })[3].done).toBe(false);
  });

  it("show the further path in the nav, complete when either path is", () => {
    expect(navProgress(onboarding())).toEqual({ done: 0, total: 3, complete: false });
    expect(navProgress(onboarding({ definitions: [starter], bindings: [server()] }))).toEqual({ done: 2, total: 4, complete: false });
    // On a path's page, the nav counts that path.
    expect(navProgress(onboarding({ tokens: [token] }), "discord")).toEqual({ done: 0, total: 4, complete: false });
    expect(navProgress(onboarding({ definitions: [starter], bindings: [server()] }), "code")).toEqual({ done: 0, total: 3, complete: false });
    expect(navProgress(onboarding({ tokens: [token], agents: [agent({ key: "quickstart" })], responses: 1 })).complete).toBe(true);
    expect(navProgress(onboarding({ bindings: [live], agents: [agent({ key: "discord-managed-ch1-1" })] })).complete).toBe(true);
  });
});

describe("deep links", () => {
  it("open a start only for the two known values, and survive sign-in only from /console/ or /console/start", () => {
    expect(startFrom("?start=discord")).toBe("discord");
    expect(startFrom("?start=code&x=1")).toBe("code");
    expect(startFrom("?start=evil")).toBeUndefined();
    expect(startNext("/console/", "?start=discord")).toBe("/console/?start=discord");
    expect(startNext("/console/start", "?start=code")).toBe("/console/?start=code");
    expect(startNext("/console/agents", "?start=code")).toBeUndefined();
    expect(startNext("/console/", "?start=https://evil.example")).toBeUndefined();
  });
});

describe("nav", () => {
  it("has five places, with the old pages grouped under them", () => {
    expect(NAV.map(item => item.label)).toEqual(["Get started", "Agents", "Channels", "API keys", "Settings"]);
    expect(groupOf("billing")?.label).toBe("Settings");
    expect(groupOf("telemetry")?.label).toBe("Settings");
    expect(groupOf("definitions")?.label).toBe("Agents");
    expect(groupOf("volumes")?.label).toBe("Agents");
    expect(groupOf("quickstart")?.label).toBe("Get started");
    expect(groupOf("tokens")?.label).toBe("API keys");
    // Every page the console had is still reachable from the nav or a group's tabs.
    const reachable = new Set([...NAV.map(item => item.to), ...Object.values(TABS).flat().map(tab => tab.to)]);
    for (const page of ["agents", "definitions", "channels", "volumes", "models", "tokens", "usage", "telemetry", "billing", "account"]) expect(reachable).toContain(page);
  });
});

describe("Get started", () => {
  it("offers the Discord bot first, then code", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    const starts = screen.getAllByRole("button", { name: /^Start (with|building)/ }).map(button => button.textContent);
    expect(starts).toEqual(["Start with Discord", "Start building"]);
    expect(screen.getByText("Durable agents, hosted")).toBeTruthy();
  });

  it("offers the no-code playground on the home itself, and takes its own URL", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    expect(screen.getByText("Try an agent right now")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(location.pathname).toBe("/console/start");
  });

  it("leaves Discord out where the shared bot is off (a self-hosted runtime)", () => {
    render(<GetStartedPage onboarding={onboarding({ discord: false })} />);
    expect(screen.getAllByRole("button", { name: /^Start (with|building)/ }).map(button => button.textContent)).toEqual(["Start building"]);
  });

  it("opens a path from ?start=, and choosing one puts it in the URL", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start building" }));
    expect(location.pathname + location.search).toBe("/console/start?start=code");
    expect(screen.getByRole("heading", { name: "Build an agent" })).toBeTruthy();
    cleanup();
    history.replaceState(null, "", "/console/?start=discord");
    render(<GetStartedPage onboarding={onboarding()} />);
    expect(screen.getByRole("heading", { name: "Build a Discord bot" })).toBeTruthy();
  });

  it("says first when a run cannot start yet", () => {
    history.replaceState(null, "", "/console/?start=code");
    render(<GetStartedPage onboarding={onboarding()} billing={{ billing: "prepaid", balance: 0, freeCredit: false } as any} />);
    expect(screen.getByText("Add credit to run agents")).toBeTruthy();
  });
});

describe("the code path", () => {
  beforeEach(() => history.replaceState(null, "", "/console/start?start=code"));

  it("creates an API key in place and fills it into every snippet, until the page is left", async () => {
    const secret = `art_${"a".repeat(64)}`;
    respond = (path, method) => path === "/v1/tokens" && method === "POST" ? json({ token: secret, id: "t1" }, 201) : undefined;
    render(<GetStartedPage onboarding={onboarding()} />);
    const code = () => [...document.querySelectorAll("pre code")].map(block => block.textContent ?? "");
    expect(code().some(block => block.includes("CAMELAI_API_KEY=art_..."))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByText("SHOWN ONCE")).toBeTruthy();
    expect(calls.find(call => call.path === "/v1/tokens" && call.method === "POST")?.body).toEqual({ name: "Quickstart" });
    expect(code().some(block => block.includes(`export CAMELAI_API_KEY=${secret}`))).toBe(true);
    expect(code().some(block => block.includes("art_..."))).toBe(false);
  });

  it("names this console's origin only when it is not the hosted runtime", () => {
    expect(snippets("https://run.camelai.com").typescript).toContain("new Agents()");
    expect(snippets("http://localhost:8790").typescript).toContain('new Agents({ url: "http://localhost:8790" })');
    expect(snippets("https://run.camelai.com").prompt).toContain("build an agent that <what it should do>");
  });

  it("runs the playground: one agent, keyed playground, with no tools, then the reply", async () => {
    respond = (path, method) => {
      if (path === "/v1/agents" && method === "POST") return json({ id: "client_p" }, 201);
      if (path === "/v1/agents/client_p") return json({ requests: [] });
      if (path === "/v1/agents/client_p/prompt") return json({ id: "r1", state: "completed", outcome: { result: { reply: "A durable agent remembers." } } }, 202);
    };
    render(<GetStartedPage onboarding={onboarding()} />);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(PLAYGROUND_PROMPT);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("A durable agent remembers.")).toBeTruthy();
    const create = calls.find(call => call.path === "/v1/agents" && call.method === "POST")!;
    expect(create.headers["Idempotency-Key"]).toBe("playground");
    expect(create.body.builtins).toEqual([]);
    expect(calls.find(call => call.path === "/v1/agents/client_p/prompt")?.body.text).toBe(PLAYGROUND_PROMPT);
  });

  it("never starts a second run while one is going: it shows the running one instead", async () => {
    let polls = 0;
    respond = path => {
      if (path === "/v1/agents/client_p") return json({ requests: [{ id: "r0", method: "prompt", state: "running" }] });
      if (path === "/v1/agents/client_p/requests/r0") return json(++polls < 2 ? { id: "r0", state: "running" } : { id: "r0", state: "completed", outcome: { result: { reply: "Earlier run's reply" } } });
    };
    render(<GetStartedPage onboarding={onboarding({ agents: [agent({ id: "client_p", key: "playground" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Earlier run's reply", {}, { timeout: 4000 })).toBeTruthy();
    expect(calls.some(call => call.path.endsWith("/prompt"))).toBe(false);
    expect(calls.some(call => call.path === "/v1/agents" && call.method === "POST")).toBe(false);
  });

  it("shows why a run stopped: a spend limit or a missing key is the result's error", async () => {
    respond = path => {
      if (path === "/v1/agents/client_p") return json({ requests: [] });
      if (path === "/v1/agents/client_p/prompt") return json({ id: "r1", state: "completed", outcome: { result: { error: "Spend limit reached", code: "spend_limit" } } });
    };
    render(<GetStartedPage onboarding={onboarding({ agents: [agent({ id: "client_p", key: "playground" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Spend limit reached")).toBeTruthy();
    expect(screen.queryByText("REPLY")).toBeNull();
  });
});

describe("the Discord path", () => {
  beforeEach(() => history.replaceState(null, "", "/console/start?start=discord"));

  it("makes a starter's definition with only builtins a server may use, then adds Camel from here", async () => {
    respond = (path, method) => path === "/v1/definitions" && method === "POST" ? json({ ...starter, id: "d9" }, 201) : undefined;
    render(<GetStartedPage onboarding={onboarding()} />);
    expect(screen.getByRole("link", { name: "Add Camel to Discord" }).getAttribute("href")).toBe("/console/discord/install?from=start");
    fireEvent.click(screen.getByRole("button", { name: /Dungeon master/ }));
    await waitFor(() => expect(calls.some(call => call.path === "/v1/definitions" && call.method === "POST")).toBe(true));
    const made = calls.find(call => call.path === "/v1/definitions" && call.method === "POST")!.body;
    expect(made.name).toBe("Discord: Dungeon master");
    expect(made.builtins).not.toContain("schedule");
    expect(made.systemPrompt).toMatch(/Ember/);
  });

  it("states what members' messages cost, with its limits, and opens setup back from Discord", async () => {
    history.replaceState(null, "", "/console/?start=discord&discord_server=101");
    render(<GetStartedPage onboarding={onboarding({ definitions: [starter], bindings: [server()] })} />);
    expect(screen.getByText(/Members' messages use your credit; limits: 3 turns per member per minute and 50 per server per day/)).toBeTruthy();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Set up Camel in My server")).toBeTruthy();
  });

  it("asks for a mention once the server is set up, and ticks it off from the first conversation", () => {
    render(<GetStartedPage onboarding={onboarding({ definitions: [starter], bindings: [live] })} />);
    expect(screen.getByRole("link", { name: "Open Discord" }).getAttribute("href")).toBe("https://discord.com/channels/101/555");
    expect(screen.getByText(/ticks when Camel gets its first mention/)).toBeTruthy();
    cleanup();
    render(<GetStartedPage onboarding={onboarding({ definitions: [starter], bindings: [live], agents: [agent({ key: "discord-managed-ch1-555" })] })} />);
    expect(screen.queryByText(/ticks when Camel gets its first mention/)).toBeNull();
    expect(screen.getByLabelText("YOUR DISCORD BOT").textContent).toContain("4/4");
  });

  it("offers tuning only once Camel is in a server, and server settings once it is set up", () => {
    render(<GetStartedPage onboarding={onboarding({ definitions: [starter] })} />);
    expect((screen.getByRole("button", { name: "Edit personality and tools" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Server settings" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Available once Camel is in your server.")).toBeTruthy();
    cleanup();
    render(<GetStartedPage onboarding={onboarding({ definitions: [starter], bindings: [live] })} />);
    expect((screen.getByRole("button", { name: "Edit personality and tools" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("link", { name: "Server settings" })).toBeTruthy();
  });

  it("numbers its cards as its checklist does", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    expect(screen.getByLabelText("YOUR DISCORD BOT").querySelectorAll("li").length).toBe(4);
    expect(screen.queryByText(/step 5/)).toBeNull();
  });

  it("explains itself where the shared bot is off", () => {
    render(<GetStartedPage onboarding={onboarding({ discord: false })} />);
    expect(screen.getByText("Camel's Discord bot isn't available here")).toBeTruthy();
  });

  it("first setup from here is open to every member in the chosen channels, at the tighter limits", async () => {
    render(<ManagedDiscordDialog config={{ enabled: true, applicationId: "999" }} binding={server()} onClose={() => {}} onSaved={() => {}}
      defaults={{ definition: "d1", public: true, ...ONBOARDING_LIMITS }} />);
    expect((screen.getByLabelText("Turns per member per minute") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Turns per server per day") as HTMLInputElement).value).toBe("50");
    expect((screen.getByRole("checkbox", { name: "Allow every member in selected channels" }) as HTMLInputElement).checked).toBe(true);
  });
});
