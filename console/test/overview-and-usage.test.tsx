import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homeIsGetStarted } from "../web/lib/onboarding";
import { utcDay } from "../web/lib/usage";
import { OverviewPage, summarize } from "../web/pages/overview";
import { UsagePage } from "../web/pages/usage";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  history.replaceState(null, "", "/console/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("overview & usage v2", () => {
  it("routes home to Get started when there are no agents", () => {
    expect(homeIsGetStarted("", 0)).toBe(true);
    expect(homeIsGetStarted("?start=code", 2)).toBe(true);
    expect(homeIsGetStarted("", 1)).toBe(false);
  });

  it("summarizes 30-day spend and prior-period comparison", () => {
    const res = summarize(
      {
        days: [
          { day: utcDay(NOW, 0), model: "azure/gpt-6.2-sol", kind: "turn", cost: 4, platformCost: 4, responses: 12, input: 1000, output: 500 },
          { day: utcDay(NOW, 31), model: "azure/gpt-6.2-sol", kind: "turn", cost: 2, platformCost: 2, responses: 5, input: 500, output: 200 },
        ],
      },
      NOW,
    );
    expect(res.spend).toBe(4);
    expect(res.prior).toBe(2);
    expect(res.responsesToday).toBe(12);
  });

  it("renders Overview from /console/v2/usage and /console/v2/agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.startsWith("/console/v2/usage")) {
          return json({
            days: [
              { day: utcDay(NOW, 0), model: "azure/gpt-6.2-sol", kind: "turn", cost: 12.5, platformCost: 12.5, responses: 42, input: 10000, output: 2000 },
            ],
          });
        }
        if (path === "/console/v2/agents") {
          return json({
            agents: [
              { id: "agt_1", key: "research-bot", model: "azure/gpt-6.2-sol", repoId: "repo_1", branch: "refs/heads/main", definition: null, running: true, createdAt: NOW - 10000, updatedAt: NOW - 1000 },
              { id: "agt_2", key: "helper", model: "openai/gpt-5", repoId: null, branch: "refs/heads/main", definition: null, running: false, createdAt: NOW - 20000, updatedAt: NOW - 5000 },
            ],
          });
        }
        return json({});
      }),
    );

    render(<OverviewPage billing={{ balanceUsd: 42.5, monthlyCapUsd: 1000, busyAgents: { busy: 1, limit: 25 }, usage: [] }} />);
    expect((await screen.findAllByText("$12.50")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("research-bot")).length).toBeGreaterThan(0);
    expect(screen.getByText("of 2 agents · 25 busy at most")).toBeTruthy();
  });

  it("renders Usage page from /console/v2/usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          days: [
            { day: utcDay(NOW, 0), model: "openai/gpt-5", kind: "turn", cost: 3.25, platformCost: 3.25, responses: 7, input: 4200, output: 800 },
          ],
        }),
      ),
    );
    render(<UsagePage />);
    expect((await screen.findAllByText("openai/gpt-5")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("$3.25")).length).toBeGreaterThan(0);
  });
});
