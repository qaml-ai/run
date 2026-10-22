import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary, Usage } from "../web/lib/api";
import { homeIsGetStarted } from "../web/lib/onboarding";
import { OverviewPage, summarize, utcDay } from "../web/pages/overview";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const row = (back: number, model: string, cost: number, fields: Partial<Usage["days"][number]> = {}): Usage["days"][number] =>
  ({ day: utcDay(NOW, back), model, kind: "turn", responses: 10, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, platformCost: 0, ...fields });
const totals = (cost: number) => ({ responses: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost });
const agent = (id: string, name: string, fields: Partial<AgentSummary> = {}): AgentSummary =>
  ({ id, name, type: "agent", model: "m", connected: false, running: false, expiresAt: null, key: null, workspaceId: null, lastActiveAt: null, lastError: null, ...fields });

describe("home", () => {
  it("is Get started with no agents or a start's deep link, and Overview after", () => {
    expect(homeIsGetStarted("", 0)).toBe(true);
    expect(homeIsGetStarted("?start=code", 3)).toBe(true);
    expect(homeIsGetStarted("", 1)).toBe(false);
    // Still loading: not decided yet (the shell waits).
    expect(homeIsGetStarted("", undefined)).toBe(false);
  });
});

describe("summarize", () => {
  it("compares the last 30 UTC days with the 30 before, by day and by model", () => {
    const usage: Usage = { since: 0, totals: totals(0), days: [
      row(0, "anthropic/sonnet", 2), row(0, "gpt-image", 1, { kind: "image" }), row(3, "anthropic/sonnet", 4), row(29, "deepseek/v4", 1),
      row(30, "anthropic/sonnet", 5), row(59, "anthropic/sonnet", 1), row(60, "anthropic/sonnet", 100),
    ] };
    const summary = summarize(usage, NOW);
    expect(summary.spend).toBe(8);
    expect(summary.prior).toBe(6);
    expect(summary.responsesToday).toBe(20);
    expect(summary.daily.length).toBe(30);
    expect(summary.daily[0]).toEqual({ day: utcDay(NOW, 29), cost: 1 });
    expect(summary.daily.at(-1)).toEqual({ day: utcDay(NOW), cost: 3 });
    expect(summary.daily[1].cost).toBe(0);
    expect(summary.models).toEqual([{ model: "anthropic/sonnet", cost: 6 }, { model: "image · gpt-image", cost: 1 }, { model: "deepseek/v4", cost: 1 }]);
  });
});

describe("Overview", () => {
  let paths: string[];
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    paths = [];
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      paths.push(path);
      const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
      if (path === "/v1/workspaces") return json([{ id: "ws_desk", name: "Trading Desk", archived: false, createdAt: 1, updatedAt: 1 }]);
      if (path === "/v1/workspace-memberships") return json([]);
      if (path === "/v1/usage?days=60&workspaceId=ws_desk") return json({ since: 0, totals: totals(0), days: [row(0, "anthropic/sonnet", 30), row(40, "anthropic/sonnet", 20)] });
      if (path === "/v1/usage?days=30") return json({ since: 0, totals: totals(60), days: [] });
      if (path.startsWith("/v1/agents?status=running")) return json([agent("a1", "desk-bot", { running: true })]);
      if (path.startsWith("/v1/agents?status=failed")) return json([
        agent("a2", "old-failure", { lastError: { at: NOW - 5 * 3600_000, class: "spend_limit" } }),
        agent("a3", "new-failure", { lastError: { at: NOW - 600_000, class: "model_error" } }),
      ]);
      if (path.startsWith("/v1/agents?limit=200")) return json([agent("a1", "desk-bot"), agent("a2", "old-failure"), agent("a3", "new-failure")]);
      return json({});
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("scopes every read to the selected workspace and shows spend, share, change, failures and running agents", async () => {
    act(() => { history.replaceState(null, "", "/console/?ws=ws_desk"); dispatchEvent(new PopStateEvent("popstate")); });
    render(<OverviewPage billing={{ busyAgents: { limit: 20 } } as any} />);
    expect((await screen.findAllByText("$30.00")).length).toBeGreaterThan(0);
    await screen.findByText(/50% of account/);
    expect(screen.getByText("50% of account · ↑ 50% vs prior 30 days")).toBeTruthy();
    expect(screen.getByText("of 3 agents · 20 busy at most")).toBeTruthy();
    expect(screen.getByText("2 agents failed · 24h")).toBeTruthy();
    expect(screen.getByText(/What Trading Desk is doing/)).toBeTruthy();
    for (const path of paths.filter(path => path.startsWith("/v1/agents"))) expect(path).toContain("workspaceId=ws_desk");

    // Needs attention: each agent's latest failure, newest first, its class and time only.
    const attention = screen.getByRole("region", { name: "Needs attention" });
    await waitFor(() => expect(within(attention).getAllByRole("link").map(link => link.textContent)).toEqual(["new-failure", "old-failure"]));
    expect(within(attention).getByText("model error")).toBeTruthy();
    expect(within(attention).getByText("10m ago")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("desk-bot")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Daily spend/ })).toBeTruthy();
  });
});
