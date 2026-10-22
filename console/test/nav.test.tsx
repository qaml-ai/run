import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleNav } from "../web/components/console-nav";
import type { Workspace } from "../web/lib/api";
import { ACCOUNT_NAV, documentTitle, groupOf, redirectFor, TABS, WORKSPACE_NAV } from "../web/lib/nav";
import { navigate, usePath } from "../web/lib/router";
import { useLayoutEffect } from "react";
import { UsagePage } from "../web/pages/usage";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const workspace = (id: string, name: string, archived = false): Workspace => ({ id, name, archived, createdAt: 1, updatedAt: 1 });
const WORKSPACES = [workspace("ws_desk", "Trading Desk"), workspace("ws_research", "Research"), workspace("ws_old", "Hackathon", true)];
const totals = (cost: number) => ({ responses: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost });

let paths: string[];
beforeEach(() => {
  paths = [];
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path);
    if (path === "/v1/workspaces") return json(WORKSPACES);
    if (path.startsWith("/v1/usage")) return json({ since: 0, totals: totals(93.45), days: [], workspaces: [{ id: "ws_desk", name: "Trading Desk", ...totals(51.4) }, { id: null, name: "Unassigned", ...totals(14.02) }] });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const go = (url: string) => act(() => { history.replaceState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); });
const href = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");
const shell = (active: string, workspaces: Workspace[] | undefined = WORKSPACES) => render(<ConsoleNav active={active} workspaces={workspaces} start={{ place: "footer" }} />);

describe("nav groups", () => {
  it("puts what workspaces scope above the Account group, and keeps every page reachable", () => {
    expect(WORKSPACE_NAV.map(item => item.label)).toEqual(["Overview", "Agents", "Definitions", "Usage", "Workspaces"]);
    expect(ACCOUNT_NAV.map(item => item.label)).toEqual(["Channels", "Volumes", "Computers", "API keys", "Models & keys", "Billing", "Settings"]);
    expect(groupOf("")?.label).toBe("Overview");
    expect(groupOf("agents")?.label).toBe("Agents");
    expect(groupOf("account")?.label).toBe("Settings");
    expect(groupOf("telemetry")?.label).toBe("Settings");
    expect(groupOf("quickstart")?.label).toBe("Get started");
    const reachable = new Set([...WORKSPACE_NAV, ...ACCOUNT_NAV].map(item => item.to).concat(Object.values(TABS).flat().map(tab => tab.to)));
    for (const page of ["agents", "definitions", "workspaces", "channels", "volumes", "computers", "models", "tokens", "usage", "telemetry", "billing", "account"]) expect(reachable).toContain(page);
  });

  it("titles the tab with the page and the workspace it shows", () => {
    expect(documentTitle("usage", "ws_desk", WORKSPACES)).toBe("Usage · Trading Desk · camelRun");
    expect(documentTitle("", "unassigned", WORKSPACES)).toBe("Overview · Unassigned · camelRun");
    expect(documentTitle("agents", undefined, WORKSPACES)).toBe("Agents · camelRun");
    // Account pages never name a workspace.
    expect(documentTitle("billing", "ws_desk", WORKSPACES)).toBe("Billing · camelRun");
    expect(documentTitle("computers", "ws_desk", WORKSPACES)).toBe("Computers · camelRun");
    expect(documentTitle("", undefined, [], true)).toBe("Get started · camelRun");
  });

  it("keeps every old URL, and redirects the ones whose page moved", () => {
    for (const path of ["", "agents", "agents/client_1", "definitions", "workspaces", "volumes", "volumes/vol_1", "channels", "tokens", "models", "usage", "billing", "telemetry", "account", "start", "quickstart"]) {
      expect(redirectFor(path, "")).toBeUndefined();
    }
    expect(redirectFor("settings", "")).toBe("telemetry");
    expect(redirectFor("overview", "?ws=ws_desk")).toBe("?ws=ws_desk");
    expect(redirectFor("usage", "?workspaceId=ws_desk")).toBe("usage?ws=ws_desk");
    expect(redirectFor("usage", "?workspaceId=all")).toBe("usage");
    expect(redirectFor("workspaces/ws_desk", "")).toBe("workspaces/ws_desk?ws=ws_desk");
    expect(redirectFor("workspaces/ws_desk", "?ws=ws_desk")).toBeUndefined();
  });
});

describe("workspace switcher", () => {
  it("is hidden for an account with no workspaces, and drops a stale ?ws=", async () => {
    go("/console/agents?ws=ws_gone");
    shell("agents", []);
    expect(screen.queryByRole("button", { name: /Workspace/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Workspaces" })).toBeTruthy();
    await waitFor(() => expect(location.search).toBe(""));
  });

  it("carries ?ws= across the scoped pages, drops it on account pages and restores it on the way back", async () => {
    go("/console/agents?ws=ws_desk");
    shell("agents");
    expect(screen.getByRole("button", { name: /Trading Desk/ })).toBeTruthy();
    expect(href("Overview")).toBe("/console/?ws=ws_desk");
    expect(href("Agents")).toBe("/console/agents?ws=ws_desk");
    expect(href("Usage")).toBe("/console/usage?ws=ws_desk");
    expect(href("Workspace settings")).toBe("/console/workspaces/ws_desk?ws=ws_desk");
    expect(href("Channels")).toBe("/console/channels");
    expect(href("API keys")).toBe("/console/tokens");

    fireEvent.click(screen.getByRole("link", { name: "Definitions" }));
    expect(location.pathname + location.search).toBe("/console/definitions?ws=ws_desk");

    fireEvent.click(screen.getByRole("link", { name: "Billing" }));
    expect(location.pathname + location.search).toBe("/console/billing");
    // The Account group never changes with the switcher; the way back restores the choice.
    expect(screen.getByRole("button", { name: /Trading Desk/ })).toBeTruthy();
    expect(href("Agents")).toBe("/console/agents?ws=ws_desk");
    fireEvent.click(screen.getByRole("link", { name: "Agents" }));
    expect(location.pathname + location.search).toBe("/console/agents?ws=ws_desk");
  });

  it("is a keyboard menu: All, active workspaces, Unassigned, archived grouped, with each one's spend", async () => {
    go("/console/usage");
    shell("usage");
    const trigger = screen.getByRole("button", { name: /All workspaces/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const choices = within(menu).getAllByRole("menuitemradio");
    expect(choices.map(choice => choice.textContent)).toEqual(["All workspaces$93.45", "Trading Desk$51.40", "Research$0.00", "Unassigned$14.02"]);
    expect(choices[0].getAttribute("aria-checked")).toBe("true");
    expect(within(menu).queryByText("Hackathon")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Archived (1)" })).toBeTruthy();
    expect(paths).toContain("/v1/usage?days=30");

    fireEvent.keyDown(choices[3], { key: "Enter" });
    await waitFor(() => expect(location.pathname + location.search).toBe("/console/usage?ws=unassigned"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /Unassigned/ })).toBeTruthy();
  });

  it("goes from a detail page to its list, and from an account page home, when switched", async () => {
    go("/console/agents/client_1?ws=ws_desk");
    shell("agents");
    fireEvent.keyDown(screen.getByRole("button", { name: /Trading Desk/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Research/ }));
    expect(location.pathname + location.search).toBe("/console/agents?ws=ws_research");
    expect(href("Workspace settings")).toBe("/console/workspaces/ws_research?ws=ws_research");

    act(() => navigate("channels"));
    fireEvent.keyDown(screen.getByRole("button", { name: /Research/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /All workspaces/ }));
    expect(location.pathname + location.search).toBe("/console/");
    expect(href("Agents")).toBe("/console/agents");
  });
});

it("reads Usage for the selected workspace, and says when it has none", async () => {
  go("/console/usage?ws=ws_desk");
  render(<UsagePage />);
  await waitFor(() => expect(paths).toContain("/v1/usage?days=60&workspaceId=ws_desk"));
  expect(await screen.findByText("No usage in the last 30 days in Trading Desk")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show all workspaces" }));
  await waitFor(() => expect(paths).toContain("/v1/usage?days=60"));
  expect(location.search).toBe("");
});

it("follows a redirect made before the location listeners attach", async () => {
  go("/console/settings");
  function Probe() {
    const path = usePath();
    useLayoutEffect(() => { const target = redirectFor(path, location.search); if (target) navigate(target, { replace: true }); }, [path]);
    return <p>at {path}</p>;
  }
  render(<Probe />);
  expect(await screen.findByText("at telemetry")).toBeTruthy();
});
