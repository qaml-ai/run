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
const membership = (kind: string, id: string) => state.memberships.find(member => member.kind === kind && member.id === id)?.workspaceId ?? null;
let writes: { path: string; method: string; body: any }[];
/** GET /v1/agents as the server answers it: filtered, by id, a page at a time with X-Next-Cursor. */
function listAgents(path: string) {
  agentPaths.push(path);
  const query = new URL(path, "http://x").searchParams, ws = query.get("workspaceId"), q = query.get("q")?.toLowerCase();
  const day = Date.now() - 24 * 3600_000;
  const list = state.agents.map(agent => ({ ...agent, workspaceId: membership("agent", agent.id) })).sort((a, b) => a.id < b.id ? -1 : 1).filter(agent =>
    (!ws || (ws === "unassigned" ? agent.workspaceId === null : agent.workspaceId === ws))
    && (query.get("status") !== "running" || agent.running) && (query.get("status") !== "failed" || (agent.lastError?.at ?? 0) > day)
    && (query.get("status") !== "expiring" || agent.expiresAt !== null) && (query.get("subAgents") !== "only" || !!agent.parentAgentId)
    && (!q || [agent.name, agent.key ?? "", agent.id].some(field => field.toLowerCase().includes(q)))
    && (!query.get("cursor") || agent.id > atob(query.get("cursor")!)));
  const limit = Number(query.get("limit") ?? Infinity), page = list.slice(0, limit);
  const next = list.length > limit ? btoa(page.at(-1)!.id) : undefined;
  return new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", ...(next ? { "X-Next-Cursor": next } : {}) } });
}
let agentPaths: string[];
beforeEach(() => {
  localStorage.clear();
  writes = []; agentPaths = [];
  state = {
    workspaces: [{ id: "ws_desk", name: "Trading Desk", archived: false, createdAt: 1, updatedAt: 1 }, { id: "ws_lab", name: "Research", archived: false, createdAt: 2, updatedAt: 2 }],
    memberships: [{ kind: "agent", id: "a_desk", workspaceId: "ws_desk" }, { kind: "agent", id: "a_lab", workspaceId: "ws_lab" }, { kind: "definition", id: "d_desk", workspaceId: "ws_desk" }],
    agents: [agent("a_desk", "desk-bot", { running: true, key: "desk-1" }), agent("a_lab", "lab-bot", { expiresAt: Date.now() + 1e6, lastActiveAt: Date.now() - 5 * 60_000, lastError: { at: Date.now() - 3600_000, class: "model_error" } }), agent("a_free", "loose-bot", { lastActiveAt: Date.now() - 3 * 86400_000 }), agent("a_sub", "desk-bot / helper", { parentAgentId: "a_desk", running: true })],
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
    if (path.startsWith("/v1/agents") && !/^\/v1\/agents\/[^?]/.test(path)) return listAgents(path);
    if (path === "/v1/definitions") return json([{ id: "d_desk", name: "Desk agent", revision: 3, createdAt: 1, updatedAt: 1 }, { id: "d_free", name: "Free agent", revision: 1, createdAt: 1, updatedAt: 1 }]);
    if (path === "/v1/channels") return json([{ id: "c1", type: "slack", name: "Desk Slack", definition: "d_desk", access: { public: true, allow: [] }, limits: {}, account: {}, credentials: {}, createdAt: 1 }]);
    if (path.startsWith("/v1/usage")) return json({ since: 0, totals: totals(100), days: [], workspaces: [{ id: "ws_desk", name: "Trading Desk", ...totals(60) }, { id: null, name: "Unassigned", ...totals(40) }] });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const go = (url: string) => act(() => { history.replaceState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); });

function Agents() {
  const billing = useApi<any>(undefined);
  return <AgentsPage hasAgents={state.agents.length > 0} billing={billing} />;
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
  it("shows each agent's workspace with all selected, and asks the server for ?ws='s", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Workspace" });
    await waitFor(() => expect(names()).toEqual(["desk-bot", "desk-bot / helper", "loose-bot", "lab-bot"]));
    expect(screen.getAllByRole("button", { name: "Assign…" }).length).toBe(2);
    expect(agentPaths.at(-1)).toBe("/v1/agents?limit=50");

    go("/console/agents?ws=ws_desk");
    await waitFor(() => expect(names()).toEqual(["desk-bot"]));
    expect(agentPaths.at(-1)).toBe("/v1/agents?limit=50&workspaceId=ws_desk");
    expect(screen.queryByRole("columnheader", { name: "Workspace" })).toBeNull();
    go("/console/agents?ws=unassigned");
    await waitFor(() => expect(names()).toEqual(["loose-bot", "desk-bot / helper"]));
  });

  it("searches and filters on the server, with last activity and recent failures", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Last active" });
    const row = (name: string) => screen.getByRole("link", { name }).closest("tr")!;
    await waitFor(() => expect(within(row("lab-bot")).getByText("5m ago")).toBeTruthy());
    expect(within(row("lab-bot")).getByText("Failed")).toBeTruthy();
    expect(within(row("loose-bot")).getByText("3d ago")).toBeTruthy();
    expect(within(row("desk-bot")).getByText("now")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "desk-1" } });
    await waitFor(() => expect(names()).toEqual(["desk-bot"]));
    expect(agentPaths.at(-1)).toBe("/v1/agents?limit=50&q=desk-1");
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "" } });
    await waitFor(() => expect(names().length).toBe(4));
    fireEvent.click(screen.getByRole("button", { name: "Running" }));
    await waitFor(() => expect(names()).toEqual(["desk-bot", "desk-bot / helper"]));
    fireEvent.click(screen.getByRole("button", { name: "Failed · 24h" }));
    await waitFor(() => expect(names()).toEqual(["lab-bot"]));
    expect(agentPaths.at(-1)).toBe("/v1/agents?limit=50&status=failed");
    fireEvent.click(screen.getByRole("button", { name: "Sub-agents" }));
    await waitFor(() => expect(names()).toEqual(["desk-bot / helper"]));
    fireEvent.click(screen.getByRole("button", { name: "Expiring" }));
    await waitFor(() => expect(names()).toEqual(["lab-bot"]));
    expect(screen.getByRole("button", { name: "Expiring" }).getAttribute("aria-pressed")).toBe("true");
    // Never the whole list: every read is a page.
    expect(agentPaths.every(path => path.includes("limit="))).toBe(true);
  });

  it("pages with the server's cursor", async () => {
    state.agents = Array.from({ length: 60 }, (_, at) => agent(`a_${String(at).padStart(2, "0")}`, `bot ${at}`));
    go("/console/agents");
    render(<Agents />);
    await waitFor(() => expect(names().length).toBe(50));
    expect(screen.getByText("Page 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(names()).toEqual(Array.from({ length: 10 }, (_, at) => `bot ${at + 50}`)));
    expect(agentPaths.at(-1)).toBe(`/v1/agents?limit=50&cursor=${encodeURIComponent(btoa("a_49"))}`);
    expect((screen.getByRole("button", { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await waitFor(() => expect(names()[0]).toBe("bot 0"));
  });

  it("moves the selected agents to a workspace in one go", async () => {
    go("/console/agents");
    render(<Agents />);
    await screen.findByRole("columnheader", { name: "Workspace" });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select loose-bot" }));
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
    await waitFor(() => expect(names()).toEqual(["desk-bot", "desk-bot / helper", "loose-bot", "lab-bot"]));
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
