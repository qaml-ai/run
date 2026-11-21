import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "../web/pages/agents";
import { ConsoleAgentChat } from "../web/pages/agent-chat";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("v2 agents & streaming chat", () => {
  it("lists agents from /console/v2/agents and loads previews from /history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/console/v2/agents") {
          return json({
            agents: [
              { id: "agt_1", key: "code-reviewer", model: "azure/gpt-6.2-sol", repoId: "repo_1", branch: "refs/heads/main", definition: "reviewer", running: false, createdAt: 1, updatedAt: Date.now() },
            ],
          });
        }
        if (path.includes("/history")) {
          return json({
            messages: [{ seq: 1, runId: "run_1", role: "assistant", content: { text: "LGTM on PR #42" }, tokensEst: 10, createdAt: 2 }],
            compaction: null,
            nextAfter: 1,
          });
        }
        return json({});
      }),
    );

    render(<AgentsPage />);
    expect(await screen.findByText("code-reviewer")).toBeTruthy();
    expect(await screen.findByText("LGTM on PR #42")).toBeTruthy();
  });

  it("loads chat history, displays pending approval input, and sends prompts to /v2/agents/:id/runs", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`: connected\n\n`));
        controller.enqueue(
          encoder.encode(
            `id: 2\nevent: text_delta\ndata: ${JSON.stringify({ seq: 2, runId: "run_2", type: "text_delta", data: { delta: "Streaming hello!" }, createdAt: 3 })}\n\n`,
          ),
        );
      },
    });

    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("/events?")) {
        return new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (path.includes("/history")) {
        return json({
          messages: [{ seq: 1, runId: "run_1", role: "user", content: { text: "Initial question" }, tokensEst: 5, createdAt: 1 }],
          compaction: null,
          nextAfter: 1,
        });
      }
      if (path.endsWith("/runs") && (!init?.method || init.method === "GET")) {
        return json({ cursor: 1, activeRunId: null, runs: [] });
      }
      if (path.endsWith("/inputs")) {
        return json({
          runs: [
            {
              id: "run_1",
              agentId: "agt_1",
              status: "input_required",
              inputs: [
                { id: "inp_1", runId: "run_1", toolCallId: "tc_1", kind: "approval", prompt: { tool: "deploy_prod" }, status: "pending", expiresAt: Date.now() + 60000 },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/runs") && init?.method === "POST") {
        return json({ id: "run_2", agentId: "agt_1", status: "running", text: "", inputs: [], toolCalls: [], filesChanged: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, vmMs: 0 }, error: null });
      }
      if (path.endsWith("/inputs/inp_1") && init?.method === "POST") {
        return json({ id: "run_1", status: "running" });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConsoleAgentChat agentId="agt_1" repoId={null} branch="refs/heads/main" />);

    expect(await screen.findByText("Initial question")).toBeTruthy();
    expect(await screen.findByText("Streaming hello!")).toBeTruthy();
    expect(await screen.findByText(/Approve tool call "deploy_prod"\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([p, init]) => String(p).endsWith("/inputs/inp_1") && init?.method === "POST")).toBe(true),
    );

    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "Follow-up prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([p, init]) => String(p).endsWith("/v2/agents/agt_1/runs") && init?.method === "POST")).toBe(true),
    );
  });
});
