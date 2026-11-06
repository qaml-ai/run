import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, ApiToken, Usage } from "../web/lib/api";
import { codeSteps, navProgress, startFrom, startNext, type useOnboarding } from "../web/lib/onboarding";
import { GetStartedPage } from "../web/pages/start";
import { PLAYGROUND_PROMPT, snippets } from "../web/pages/start-code";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const agent = (fields: Partial<AgentSummary> = {}): AgentSummary => ({ id: "client_1", name: "a", type: "general", model: "m", connected: false, running: false, expiresAt: null, key: null, ...fields });
const usage = (responses: number) => ({ since: 0, totals: { responses, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, days: [] }) as Usage;
const token: ApiToken = { id: "t1", name: "k", prefix: "art_1234", createdAt: 1 };

/** What useOnboarding returns, from plain data. */
function onboarding({ tokens = [], agents = [], responses = 0 }: {
  tokens?: ApiToken[]; agents?: AgentSummary[]; responses?: number;
} = {}): ReturnType<typeof useOnboarding> {
  const state = <T,>(data: T) => ({ data, error: undefined, loading: false, reload: vi.fn(async () => {}) });
  return {
    tokens: state(tokens), agents: state(agents), usage: state(usage(responses)), code: codeSteps({ tokens, agents, usage: usage(responses) }), loaded: true,
  };
}

let calls: { path: string; method: string; body?: any; headers: Record<string, string> }[];
let respond: (path: string, method: string, body: any) => Response | undefined;
beforeEach(() => {
  calls = []; respond = () => undefined;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: init.headers as Record<string, string> });
    return respond(path, method, body) ?? json([]);
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

  it("show the code path's progress in the nav, complete when it is", () => {
    expect(navProgress(onboarding())).toEqual({ done: 0, total: 3, complete: false });
    expect(navProgress(onboarding({ tokens: [token] }), "code")).toEqual({ done: 1, total: 3, complete: false });
    expect(navProgress(onboarding({ tokens: [token], agents: [agent({ key: "quickstart" })], responses: 1 })).complete).toBe(true);
  });
});

describe("deep links", () => {
  it("open a start only for the known value, and survive sign-in only from /console/ or /console/start", () => {
    expect(startFrom("?start=code&x=1")).toBe("code");
    expect(startFrom("?start=evil")).toBeUndefined();
    // Discord bots live in camelBots now: an old ?start=discord link opens the home.
    expect(startFrom("?start=discord")).toBeUndefined();
    expect(startNext("/console/", "?start=discord")).toBeUndefined();
    expect(startNext("/console/start", "?start=code")).toBe("/console/?start=code");
    expect(startNext("/console/agents", "?start=code")).toBeUndefined();
    expect(startNext("/console/", "?start=https://evil.example")).toBeUndefined();
  });
});

describe("Get started", () => {
  it("offers the code path, and no Discord bot", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    const starts = screen.getAllByRole("button", { name: /^Start (with|building)/ }).map(button => button.textContent);
    expect(starts).toEqual(["Start building"]);
    expect(screen.queryByText(/Discord/)).toBeNull();
    expect(screen.getByText("Durable agents, hosted")).toBeTruthy();
  });

  it("offers the no-code playground on the home itself, and takes its own URL", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    expect(screen.getByText("Try an agent right now")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(location.pathname).toBe("/console/start");
  });

  it("opens a path from ?start=, and choosing one puts it in the URL", () => {
    render(<GetStartedPage onboarding={onboarding()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start building" }));
    expect(location.pathname + location.search).toBe("/console/start?start=code");
    expect(screen.getByRole("heading", { name: "Build an agent" })).toBeTruthy();
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
