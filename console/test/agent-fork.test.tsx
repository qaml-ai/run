import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForkDialog } from "../web/pages/agent";
import type { AgentDetail } from "../web/lib/api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const agent = { id: "client_source", name: "Support" } as AgentDetail;
let calls: { path: string; body?: any }[];
let answer: () => Response;
beforeEach(() => {
  calls = [];
  answer = () => json({ id: "client_fork", forkedFrom: { agentId: "client_source", atMessage: 3 } }, 201);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return answer();
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

describe("ForkDialog", () => {
  it("forks from a message under one key, then opens the fork", async () => {
    const closed = vi.fn();
    render(<ForkDialog agent={agent} atMessage={3} onClose={closed} />);
    expect(screen.getByText(/through message 3/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Try B" } });
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/v1/agents/client_source/fork");
    expect(calls[0].body).toMatchObject({ name: "Try B", atMessage: 3 });
    expect(calls[0].body.key).toMatch(/^fork-[0-9a-f-]{36}$/);
    expect(location.pathname).toMatch(/agents\/client_fork$/);
  });

  it("shows why a fork was refused, and sends the same key again", async () => {
    answer = () => json({ error: "Message 3 is in a turn that has not ended yet", code: "FORK_POINT_RUNNING" }, 409);
    render(<ForkDialog agent={agent} onClose={() => {}} />);
    expect(screen.getByText(/through its last finished turn/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(await screen.findByText(/has not ended yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body.key).toBe(calls[0].body.key);
    expect(calls[0].body.atMessage).toBeUndefined();
  });
});
