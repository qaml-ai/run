import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AgentProvider, createAgentChat } from "@camelai/run-react";
import { AgentInputView } from "../../packages/registry/src/agent-chat/agent-parts";
import { AgentChatView } from "../../packages/registry/src/agent-chat/agent-chat";
import { fakeChat } from "../../packages/react/test/fake-chat";
import { ConsoleComposer, consoleChatFetch, suggestedPrompts } from "../web/pages/agent-chat";
afterEach(cleanup);
it("streams tokens from the authenticated event API into the registry chat", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encode = new TextEncoder();
  const request = vi.fn(async (path: RequestInfo | URL) => {
    if (String(path).includes("/events?")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } });
    if (String(path).includes("/history")) return Response.json({ entries: [], next: null });
    if (String(path).includes("/inputs")) return Response.json([]);
    return Response.json({ requests: [] });
  });
  const chat = createAgentChat({ endpoint: "/v1/agents/a", fetch: consoleChatFetch("a", () => {}, request), watch: { transport: "sse" }, autoConnect: false });
  render(<AgentProvider chat={chat}><AgentChatView /></AgentProvider>);
  chat.connect();
  await waitFor(() => expect(stream).toBeTruthy());
  const frame = (data: unknown) => stream.enqueue(encode.encode(`data: ${JSON.stringify(data)}\n\n`));
  await act(async () => {
    frame({ type: "snapshot", turn: null });
    frame({ type: "event", event: { type: "agent_start" } });
    frame({ type: "event", event: { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } } });
    frame({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } } });
    frame({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Live answer" } } });
  });
  await screen.findByText("Live answer");
  expect(request.mock.calls.some(([path]) => String(path).includes("/events?snapshot=1"))).toBe(true);
  chat.destroy();
});
it("renders collapsed tools, workers, sender labels and answers an inline question", async () => {
  const input = { id: "q1", toolCallId: "ask", kind: "question", message: "Choose", detail: { questions: [{ question: "Which?", options: [{ label: "First" }] }] }, answering: false } as any;
  const fake = fakeChat({ status: "input_required", inputs: [input], messages: [
    { id: "u", role: "user", text: "hello", parts: [], from: { id: "guest", name: "Guest" }, status: "sent", createdAt: 1 },
    { id: "a", role: "assistant", createdAt: 2, streaming: false, parts: [
      { type: "tool", id: "t", name: "search", args: {}, state: "done", result: { text: "found", content: [] } },
      { type: "tool", id: "w", name: "delegate", args: {}, state: "running", subagent: { agentId: "w", name: "Researcher", messages: [], progress: "Reading sources" } },
      { type: "tool", id: "ask", name: "ask_user", args: {}, state: "input_required", input },
    ] },
  ] });
  render(<AgentProvider chat={fake.chat}><AgentChatView /></AgentProvider>);
  expect(screen.getByText("Guest")).toBeTruthy();
  expect(screen.getByText("Used search").closest("details")?.open).toBe(false);
  expect(screen.getByText("Researcher · working")).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: "First" }));
  expect(fake.chat.answer).toHaveBeenCalledExactlyOnceWith(input, { "Which?": "First" });
  act(() => fake.set({ inputs: [], answers: [{ input, answer: { action: "accept", content: { answers: { "Which?": "First" } } } }] }));
  expect(screen.getByText("You chose First").closest("details")?.open).toBe(false);
  expect(screen.queryByRole("radio")).toBeNull();
});
it("disables empty sends, queues or steers while running, stops and loads history", async () => {
  const fake = fakeChat({ status: "streaming", hasOlder: true });
  render(<AgentProvider chat={fake.chat}><AgentChatView composer={<ConsoleComposer />} /></AgentProvider>);
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Next");
  await userEvent.keyboard("{Enter}");
  expect(fake.chat.send).toHaveBeenCalledWith("Next", { whileRunning: "queue", data: { files: [] } });
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Change course");
  await userEvent.click(screen.getByRole("button", { name: "Steer instead" }));
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(fake.chat.send).toHaveBeenCalledWith("Change course", { whileRunning: "steer", data: { files: [] } });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(fake.chat.stop).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
  expect(fake.chat.loadOlder).toHaveBeenCalled();
});
it("routes sends, answers, attachments and aborts with CSRF headers", async () => {
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: "ok" }));
  const fetcher = consoleChatFetch("a", () => {}, request);
  for (const body of [{ action: "send", text: "go", clientId: "c", data: { files: [{ path: "/x" }] } }, { action: "answer", inputId: "q", answer: { action: "accept", content: { answers: {} } } }, { action: "stop" }]) await fetcher("/v1/agents/a", { method: "POST", body: JSON.stringify(body) });
  expect(request.mock.calls.map(call => call[0])).toEqual(["/v1/agents/a/prompt", "/v1/agents/a/inputs/q", "/v1/agents/a/abort"]);
  const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(new Headers(init.headers).get("X-Agent-Runtime-Console")).toBe("1");
  expect(JSON.parse(String(init.body)).files).toEqual([{ path: "/x" }]);
});

it("keeps newlines, supports Alt+Enter steering and names attachment controls", async () => {
  const fake = fakeChat({ status: "streaming" });
  render(<AgentProvider chat={fake.chat}><ConsoleComposer /></AgentProvider>);
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(message, "First{Shift>}{Enter}{/Shift}Second");
  expect(fake.chat.send).not.toHaveBeenCalled();
  expect((message as HTMLTextAreaElement).value).toBe("First\nSecond");
  await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
  expect(fake.chat.send).toHaveBeenCalledWith("First\nSecond", { whileRunning: "steer", data: { files: [] } });
  expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
});
it("enables Submit for Other text and multi-select answers", async () => {
  const answer = vi.fn();
  const input = { id: "q", kind: "question", message: "Region", detail: { questions: [{ question: "Region?", multiSelect: true, options: [{ label: "Europe" }] }] }, answering: false } as any;
  render(<AgentInputView input={input} onAnswer={answer} />);
  const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await userEvent.click(screen.getByRole("checkbox", { name: "Europe" }));
  expect(submit.disabled).toBe(false);
  expect(answer).not.toHaveBeenCalled();
  await userEvent.click(submit);
  expect(answer).toHaveBeenCalledWith({ "Region?": ["Europe"] });
});
it("offers definition-specific prompts in an empty conversation", async () => {
  const fake = fakeChat();
  render(<AgentProvider chat={fake.chat}><AgentChatView suggestions={suggestedPrompts("Research new markets")} /></AgentProvider>);
  await userEvent.click(screen.getByRole("button", { name: "Help me get started: Research new markets" }));
  expect(fake.chat.send).toHaveBeenCalledWith("Help me get started: Research new markets");
});
