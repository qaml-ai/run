import { previewText, useAgentPreviews } from "../web/lib/agent-previews";
import { cleanup, render, screen, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPreview } from "../web/pages/agents";
import type { AgentSummary } from "../web/lib/api";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows the last message, pending inputs and opens the agent chat", async () => {

  render(<AgentPreview preview="The report is ready" pending={2} agent={{ id: "a", name: "Analyst", running: false, lastActiveAt: Date.now() } as AgentSummary} />);
  await screen.findByText("The report is ready");
  expect(await screen.findByText("2 pending")).toBeTruthy();
  expect(screen.getByText("Waiting on you")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toContain("agents/a");
});

it("flattens Markdown and refreshes previews only when activity changes", async () => {
  expect(previewText("# Report\n\n**Ready** for [review](https://example.com).\n- `Done`\n> Fine")).toBe("Report Ready for review. Done Fine");
  const fetcher = vi.fn(async () => Response.json({ entries: [{ message: { role: "assistant", content: "**Ready**" } }] }));
  vi.stubGlobal("fetch", fetcher);
  const agent = { id: "a", lastActiveAt: 1 } as AgentSummary;
  const { result, rerender } = renderHook(({ agents }) => useAgentPreviews(agents), { initialProps: { agents: [agent] } });
  await waitFor(() => expect(result.current.a).toBe("Ready"));
  rerender({ agents: [{ ...agent }] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender({ agents: [{ ...agent, lastActiveAt: 2 }] });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
