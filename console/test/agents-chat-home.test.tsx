import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPreview } from "../web/pages/agents";
import type { AgentSummary } from "../web/lib/api";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows the last message, pending inputs and opens the agent chat", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path.includes("/history") ? { entries: [{ message: { role: "assistant", content: [{ type: "text", text: "The report is ready" }] } }] } : [{ kind: "decision" }, { kind: "question" }])));
  render(<AgentPreview agent={{ id: "a", name: "Analyst", running: false, lastActiveAt: Date.now() } as AgentSummary} />);
  await screen.findByText("The report is ready");
  expect(await screen.findByText("2 pending")).toBeTruthy();
  expect(screen.getByText("Waiting on you")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toContain("agents/a");
});
