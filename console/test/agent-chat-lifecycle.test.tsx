import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fakeChat } from "../../packages/react/test/fake-chat";
import { ConsoleAgentChat } from "../web/pages/agent-chat";
import { AgentInputView } from "../../packages/registry/src/agent-chat/agent-parts";
let chat: ReturnType<typeof fakeChat>["chat"];
vi.mock("@camelai/run-react", async importOriginal => ({ ...await importOriginal<object>(), useAgentChat: () => chat }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("restarts refresh after Strict Mode cleanup and observes layout changes", async () => {
  chat = fakeChat().chat;
  const observers: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
  let top = 200;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
  const fetcher = vi.fn(async (path: string) => Response.json(path.endsWith("/children") ? { children: [] } : { queuedRuns: 2 }));
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<StrictMode><ConsoleAgentChat agentId="a" /></StrictMode>);
  await screen.findByText(/2 queued/);
  expect(fetcher.mock.calls.map(([path]) => path)).toContain("/v1/agents/a/children");
  const frame = container.firstElementChild as HTMLElement;
  const height = parseFloat(frame.style.height);
  top += 80; observers.forEach(observer => observer([], {} as ResizeObserver));
  expect(parseFloat(frame.style.height)).toBe(height - 80);
});
it("renders a worker once when history and children both contain it", async () => {
  chat = fakeChat({ messages: [{ id: "m", role: "assistant", createdAt: 1, streaming: false, parts: [{ type: "tool", id: "tc", name: "delegate", state: "running", args: {}, subagent: { agentId: "child", name: "Researcher", messages: [] } }] }] }).chat;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path.endsWith("/children") ? { children: [{ agentId: "child", toolCallId: "tc", requestId: "r", name: "Researcher", status: "running", startedAt: Date.now() - 5000, progress: "Reading sources" }] } : { queuedRuns: 0 })));
  render(<ConsoleAgentChat agentId="a" />);
  await screen.findByText("Reading sources");
  expect(screen.getAllByText("Researcher · working")).toHaveLength(1);
});
it("gives repeated input cards unique DOM ids and an explicit approve action", () => {
  const input = { id: "same", kind: "approval", message: "Approve?", detail: {}, answering: false } as any;
  const { container } = render(<><AgentInputView input={input} onAnswer={() => {}} /><AgentInputView input={input} onAnswer={() => {}} /></>);
  const ids = [...container.querySelectorAll("[data-input-id]")].map(element => element.id);
  expect(new Set(ids).size).toBe(2);
  expect(container.querySelectorAll('[data-input-action="approve"]')).toHaveLength(2);
});
