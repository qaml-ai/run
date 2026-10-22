import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApi, type AgentSummary } from "../web/lib/api";
import { AgentsPage } from "../web/pages/agents";
import { ChannelsPage } from "../web/pages/channels";
import { DefinitionsPage } from "../web/pages/definitions";
import { UsagePage } from "../web/pages/usage";
import { WorkspaceSettingsPage, WorkspacesPage } from "../web/pages/workspaces";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const totals = (cost: number) => ({ responses: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost });
const agent = (id: string, name: string, fields: Partial<AgentSummary> = {}): AgentSummary =>
  ({ id, name, type: "agent", model: "m", connected: false, running: false, expiresAt: null, key: null, ...fields });

/** A small fake of the workspace endpoints, with the writes it took. */
let state: { workspaces: any[]; memberships: { kind: string; id: string; workspaceId: string | null }[]; agents: AgentSummary[] };
let writes: { path: string; method: string; body: any }[];
beforeEach(() => {
  localStorage.clear();
  writes = [];
  state = {
    workspaces: [{ id: "ws_desk", name: "Trading Desk", archived: false, createdAt: 1, updatedAt: 1 }, { id: "ws_lab", name: "Research", archived: false, createdAt: 2, updatedAt: 2 }],
    memberships: [{ kind: "agent", id: "a_desk", workspaceId: "ws_desk" }, { kind: "agent", id: "a_lab", workspaceId: "ws_lab" }, { kind: "definition", id: "d_desk", workspaceId: "ws_desk" }],
    agents: [agent("a_desk", "desk-bot", { running: true, key: "desk-1" }), agent("a_lab", "lab-bot", { expiresAt: Date.now() + 1e6 }), agent("a_free", "loose-bot"), agent("a_sub", "desk-bot / helper", { parentAgentId: "a_desk", running: true })],
  };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "/v1/workspaces" && method === "POST") { const created = { id: "ws_new", name: body.name, archived: false, createdAt: 3, updatedAt: 3 }; state.workspaces.push(created); return json(created); }
    const patch = path.match(/^\/v1\/workspaces\/([^/]+)$/);
    if (patch && method === "PATCH") { const found = state.workspaces.find(workspace => workspace.id === patch[1]); Object.assign(found, body, { updatedAt: found.updatedAt + 1 }); return json(found); }
    const put = path.match(/^\/v1\/workspace-memberships\/(agent|definition)\/(.+)$/);
    if (put) {
      state.memberships = [...state.memberships.filter(member => !(member.kind === put[1] && member.id === put[2])), { kind: put[1], id: put[2], workspaceId: body.workspaceId }];
      return json({ workspaceId: body.workspaceId });
    }
    if (path === "/v1/workspaces") return json(state.workspaces);
    if (path === "/v1/workspace-memberships") return json(state.memberships);
    if (path === "/v1/agents") return json(state.agents);
    if (path === "/v1/definitions") return json([{ id: "d_desk", name: "Desk agent", revision: 3, createdAt: 1, updatedAt: 1 }, { id: "d_free", name: "Free agent", revision: 1, createdAt: 1, updatedAt: 1 }]);
    if (path === "/v1/channels") return json([{ id: "c1", type: "slack", name: "Desk Slack", definition: "d_desk", access: { public: true, allow: [] }, limits: {}, account: {}, credentials: {}, createdAt: 1 }]);
    if (path.startsWith("/v1/usage")) return json({ since: 0, totals: totals(100), days: [], workspaces: [{ id: "ws_desk", name: "Trading Desk", ...totals(60) }, { id: null, name: "Unassigned", ...totals(40) }] });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const go = (url: string) => act(() => { history.replaceState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); });
const membership = (kind: string, id: string) => state.memberships.find(member => member.kind === kind && member.id === id)?.workspaceId ?? null;

function Agents() {
  const agents = useApi<AgentSummary[]>("/v1/agents");
  const billing = useApi<any>(undefined);
  return <AgentsPage agents={agents} billing={billing} />;
}
const names = () => screen.getAllByRole("link").map(link => link.textContent).filter(text => text?.includes("bot"));

describe("workspaces index", () => {
  it("shows a card per workspace with spend and members, and Unassigned with the fix", async () => {
    go("/console/workspaces");
    render(<WorkspacesPage />);
    expect(await screen.findByRole("link", { name: "Trading Desk" })).toBeTruthy();
    await screen.findByText("$60.00");
    expect(screen.getByText("last 30 days · 60% of spend")).toBeTruthy();
    expect(screen.getByText("1 agent · 1 definition")).toBeTruthy();
    expect(screen.getByText("1 agent · 0 definitions")).toBeTruthy();
    expect(screen.getByText("2 agents · 1 definition")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    // Unassigned: the loose agent and the sub-agent, with the way to assign them.
    expect(screen.getByRole("link", { name: /Assign 2 agents/ }).getAttribute("href")).toBe("/console/agents?ws=unassigned");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("creates a workspace from the dialog and opens its settings", async () => {
    go("/console/workspaces");
    render(<WorkspacesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "Support" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(location.pathname + location.search).toBe("/console/workspaces/ws_new?ws=ws_new"));
    expect(writes).toEqual([{ path: "/v1/workspaces", method: "POST", body: { name: "Support" } }]);
  });
});

describe("workspace settings", () => {
  it("renames, lists its definitions with their channels, adds and moves agents, and archives", async () => {
    go("/console/workspaces/ws_desk?ws=ws_desk");
    render(<WorkspaceSettingsPage id="ws_desk" />);
    const name = await screen.findByLabelText("Workspace name");
    fireEvent.change(name, { target: { value: "Desk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes[0]).toEqual({ path: "/v1/workspaces/ws_desk", method: "PATCH", body: { name: "Desk" } }));
    expect(await screen.findByText("Desk Slack")).toBeTruthy();
    expect(screen.getByText("Agents · 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add agents/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /loose-bot/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 agent" }));
    await waitFor(() => expect(membership("agent", "a_free")).toBe("ws_desk"));
    expect(await screen.findByText("Agents · 2")).toBeTruthy();

    fireEvent.keyDown(screen.getAllByRole("button", { name: "Move…" })[0], { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Research/ }));
    await waitFor(() => expect(membership("agent", "a_desk")).toBe("ws_lab"));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(membership("definition", "d_desk")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Archive workspace" }));
    expect(await screen.findByRole("button", { name: "Restore workspace" })).toBeTruthy();
    expect(writes.at(-1)).toEqual({ path: "/v1/workspaces/ws_desk", method: "PATCH", body: { archived: true } });
    expect((screen.getByRole("button", { name: /Add agents/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("agents list", () => {
  it("shows each agent's workspace with all selected, and filters by ?ws=", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Workspace" });
    expect(names()).toEqual(["desk-bot", "desk-bot / helper", "lab-bot", "loose-bot"]);
    expect(screen.getAllByRole("button", { name: "Assign…" }).length).toBe(2);

    go("/console/agents?ws=ws_desk");
    await waitFor(() => expect(names()).toEqual(["desk-bot"]));
    expect(screen.queryByRole("columnheader", { name: "Workspace" })).toBeNull();
    go("/console/agents?ws=unassigned");
    await waitFor(() => expect(names()).toEqual(["loose-bot", "desk-bot / helper"]));
  });

  it("searches name, key or id, and filters by status", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Workspace" });
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "desk-1" } });
    expect(names()).toEqual(["desk-bot"]);
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Running 2" }));
    expect(names()).toEqual(["desk-bot", "desk-bot / helper"]);
    fireEvent.click(screen.getByRole("button", { name: "Sub-agents 1" }));
    expect(names()).toEqual(["desk-bot / helper"]);
    fireEvent.click(screen.getByRole("button", { name: "Expiring 1" }));
    expect(names()).toEqual(["lab-bot"]);
    expect(screen.getByRole("button", { name: "Expiring 1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("moves the selected agents to a workspace in one go", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Workspace" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select loose-bot" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select lab-bot" }));
    const bar = screen.getByRole("region", { name: "Selected agents" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    fireEvent.keyDown(within(bar).getByRole("button", { name: /Move to workspace/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Trading Desk/ }));
    await waitFor(() => expect([membership("agent", "a_free"), membership("agent", "a_lab")]).toEqual(["ws_desk", "ws_desk"]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Selected agents" })).toBeNull());
  });

  it("stays as before for an account with no workspaces", async () => {
    state.workspaces = []; state.memberships = [];
    go("/console/agents?ws=ws_desk");
    render(<Agents />);
    await waitFor(() => expect(names()).toEqual(["desk-bot", "desk-bot / helper", "lab-bot", "loose-bot"]));
    expect(screen.queryByRole("columnheader", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

it("filters definitions by ?ws= and moves one from its row", async () => {
  go("/console/definitions?ws=ws_desk");
  render(<DefinitionsPage />);
  expect(await screen.findByText("Desk agent")).toBeTruthy();
  expect(screen.queryByText("Free agent")).toBeNull();
  go("/console/definitions");
  fireEvent.keyDown(await screen.findByRole("button", { name: "Workspace for Free agent" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Research/ }));
  await waitFor(() => expect(membership("definition", "d_free")).toBe("ws_lab"));
});

it("shows the workspace a channel's agents join, through its definition", async () => {
  go("/console/channels");
  render(<ChannelsPage />);
  const row = (await screen.findByText("Desk Slack")).closest("tr")!;
  await waitFor(() => expect(within(row).getByText("Trading Desk")).toBeTruthy());
});

it("filters usage when a workspace total is selected", async () => {
  const paths: string[] = [];
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { paths.push(path); return fetch(path, init); }));
  go("/console/usage");
  render(<UsagePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Trading Desk" }));
  await waitFor(() => expect(paths).toContain("/v1/usage?days=30&workspaceId=ws_desk"));
});
