import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsagePage } from "../web/pages/usage";
import { WorkspacesPage } from "../web/pages/workspaces";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("creates a workspace and assigns an existing agent without changing its configuration", async () => {
  const writes: { path: string; method: string; body: any }[] = [];
  let workspaces: any[] = [], memberships: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ path, method, body });
    if (path === "/v1/workspaces" && method === "POST") workspaces = [{ id: "ws_desk", name: body.name, archived: false, createdAt: 1, updatedAt: 1 }];
    if (path.startsWith("/v1/workspace-memberships/")) memberships = [{ kind: "agent", id: "client_test", workspaceId: body.workspaceId }];
    const value = path === "/v1/workspaces" ? workspaces : path === "/v1/workspace-memberships" ? memberships
      : path === "/v1/agents" ? [{ id: "client_test", name: "Morning report" }] : path === "/v1/definitions" ? [] : { workspaces: [] };
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  }));
  render(<WorkspacesPage />);
  fireEvent.change(screen.getByLabelText("Workspace name"), { target: { value: "Trading Desk" } });
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  await screen.findByLabelText("Rename Trading Desk");
  await waitFor(() => expect((screen.getByLabelText("Workspace for Morning report") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Workspace for Morning report"), { target: { value: "ws_desk" } });
  await waitFor(() => expect(writes).toEqual([
    { path: "/v1/workspaces", method: "POST", body: { name: "Trading Desk" } },
    { path: "/v1/workspace-memberships/agent/client_test", method: "PUT", body: { workspaceId: "ws_desk" } },
  ]));
});

it("filters usage when a workspace total is selected", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path);
    const totals = { responses: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 };
    const value = path === "/v1/workspaces" ? [{ id: "ws_desk", name: "Trading Desk", archived: false }]
      : { totals, days: [], workspaces: [{ id: "ws_desk", name: "Trading Desk", ...totals }] };
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  }));
  render(<UsagePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Trading Desk" }));
  await waitFor(() => expect(paths).toContain("/v1/usage?days=30&workspaceId=ws_desk"));
});
