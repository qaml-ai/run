import { useEffect } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { projectMessages, type ChatInput, type LocalSend, type ProjectInput, type ProjectMemo, type UserChatMessage } from "@camelai/run/chat";
import { AgentChat, Markdown, UserMessage } from "@camelai/run-react/ui";
import type { ToolRenderProps } from "@camelai/run-react";
import { fakeChat } from "./fake-chat.ts";

const user = (text: string, timestamp: number, extra: object = {}) => ({ role: "user", content: text, timestamp, ...extra }) as ProjectInput["messages"][number];
const assistant = (content: object[], timestamp: number, extra: object = {}) => ({ role: "assistant", content, provider: "p", model: "m", stopReason: "stop", timestamp, ...extra }) as any;
const toolResult = (toolCallId: string, text: string, timestamp: number, extra: object = {}) => ({ role: "toolResult", toolCallId, toolName: "t", content: [{ type: "text", text }], isError: false, timestamp, ...extra }) as any;

/** A chat whose snapshot follows a script of agent views, projected as the real store does. */
function scripted() {
  const fake = fakeChat({ status: "ready" });
  const memo: ProjectMemo = new Map();
  const show = (view: Partial<ProjectInput>, status: "ready" | "submitted" | "streaming" | "input_required" = "ready", inputs: ChatInput[] = []) => {
    const messages = projectMessages({ messages: [], partial: null, running: false, ...view, inputs, indexes: view.indexes ?? (view.messages ?? []).map((_, at) => at) }, memo);
    act(() => fake.set({ messages, status, inputs }));
  };
  return { ...fake, show };
}

describe("<AgentChat>", () => {
  it("shows the conversation: markdown, tool cards, files, and who said what", async () => {
    const chat = scripted();
    render(<AgentChat chat={chat.chat} />);
    chat.show({
      messages: [
        user("Chart my sales", 1, { requestId: "cm_1", from: { id: "u1", name: "Ada" } }),
        assistant([{ type: "toolCall", id: "c1", name: "js_exec", arguments: { code: "return 42" } }], 2, { stopReason: "toolUse" }),
        toolResult("c1", "42", 3),
        assistant([{ type: "toolCall", id: "c2", name: "present_file", arguments: { path: "/workspace/sales.csv" } }], 4, { stopReason: "toolUse" }),
        toolResult("c2", JSON.stringify({ path: "/workspace/sales.csv", size: 2048, contentType: "text/csv" }), 5),
        assistant([{ type: "text", text: "Here is **your** chart:\n\n- one\n- two" }], 6),
      ],
    });
    expect(screen.getByText("Chart my sales")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("your").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem").map(item => item.textContent)).toEqual(["one", "two"]);
    expect(screen.getByText("Used js_exec")).toBeTruthy();
    expect(screen.getByText("return 42")).toBeTruthy();
    expect(screen.getByText("sales.csv")).toBeTruthy();
    // The file's link comes through the handler.
    await act(async () => {});
    expect(chat.chat.fileUrl).toHaveBeenCalledWith("/workspace/sales.csv");
    expect(screen.getByText("sales.csv").closest("a")!.getAttribute("href")).toBe("https://files.test/workspace/sales.csv");
  });

  it("shows a delegate call's sub-agent as a collapsible transcript under its call", () => {
    const chat = scripted();
    render(<AgentChat chat={chat.chat} />);
    const messages = [user("Research it", 1), assistant([{ type: "toolCall", id: "d1", name: "delegate", arguments: { agent: "researcher", task: "dig" } }], 2, { stopReason: "toolUse" })];
    const working = { agentId: "client_child", name: "researcher", messages: [assistant([{ type: "toolCall", id: "w1", name: "web__search", arguments: {} }], 3, { stopReason: "toolUse" })] };
    chat.show({ messages, running: true, subagents: new Map([["d1", working]]) }, "streaming");
    expect(screen.getByText("Sub-agent researcher · 1 message")).toBeTruthy();
    expect(screen.getByText("→ search")).toBeTruthy();
    const done = { ...working, status: "completed" as const, messages: [...working.messages, assistant([{ type: "text", text: "Found three sources." }], 4)] };
    chat.show({ messages: [...messages, toolResult("d1", JSON.stringify({ status: "completed", text: "Found three sources." }), 5)], subagents: new Map([["d1", done]]) });
    expect(screen.getByText("Sub-agent researcher · 2 messages").closest("details")!.getAttribute("data-state")).toBe("done");
    expect(screen.getByText("Found three sources.", { selector: "code" })).toBeTruthy();
  });

  it("does not remount a sent message when the agent's copy arrives, nor the reply while it streams", () => {
    const chat = scripted();
    const mounts = new Map<string, number>();
    function CountingUser({ message }: { message: UserChatMessage }) {
      useEffect(() => { mounts.set(message.id, (mounts.get(message.id) ?? 0) + 1); }, []);
      return <UserMessage message={message} />;
    }
    render(<AgentChat chat={chat.chat} components={{ UserMessage: CountingUser }} />);
    const history = [user("q1", 1, { requestId: "cm_1" }), assistant([{ type: "text", text: "a1" }], 2)];
    const sending: LocalSend = { id: "cm_2", text: "q2", createdAt: 3, status: "sending" };
    chat.show({ messages: history });
    chat.show({ messages: history, local: [sending] }, "submitted");
    chat.show({ messages: history, local: [{ ...sending, status: "sent" }], running: true }, "submitted");
    const arrived = [...history, user("q2", 3, { requestId: "cm_2" })];
    chat.show({ messages: arrived, running: true, local: [{ ...sending, status: "sent" }] }, "submitted");
    const answer = screen.getByText("a1").closest(".agent-chat__message")!;
    for (const text of ["He", "Hello", "Hello there"]) chat.show({ messages: arrived, running: true, partial: assistant([{ type: "text", text }], 4) }, "streaming");
    const streamingRow = screen.getByText("Hello there").closest(".agent-chat__message")!;
    chat.show({ messages: [...arrived, assistant([{ type: "text", text: "Hello there" }], 4)] });
    expect(mounts.get("cm_2")).toBe(1);
    expect(mounts.get("cm_1")).toBe(1);
    expect(screen.getByText("a1").closest(".agent-chat__message")).toBe(answer);
    expect(screen.getByText("Hello there").closest(".agent-chat__message")).toBe(streamingRow);
    expect(document.querySelectorAll(".agent-chat__message").length).toBe(4);
  });

  it("the composer sends on Enter, keeps Shift+Enter for new lines, and offers Stop while the agent works", async () => {
    const chat = scripted();
    render(<AgentChat chat={chat.chat} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(box, "first line{Shift>}{Enter}{/Shift}second");
    expect((box as HTMLTextAreaElement).value).toBe("first line\nsecond");
    await userEvent.type(box, "{Enter}");
    expect(chat.chat.send).toHaveBeenCalledWith("first line\nsecond", {});
    expect((box as HTMLTextAreaElement).value).toBe("");
    chat.show({ messages: [] }, "streaming");
    const stop = screen.getByRole("button", { name: "Stop" });
    await userEvent.click(stop);
    expect(chat.chat.stop).toHaveBeenCalledTimes(1);
    await userEvent.type(box, "{Escape}");
    expect(chat.chat.stop).toHaveBeenCalledTimes(2);
    await userEvent.type(box, "more");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("asks the agent's questions and approvals, and answers them", async () => {
    const chat = scripted();
    render(<AgentChat chat={chat.chat} />);
    const question = { id: "inp_q", toolCallId: "c1", kind: "question", message: "Which region?", answering: false,
      detail: { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] } } as unknown as ChatInput;
    const approval = { id: "inp_a", toolCallId: "c2", kind: "approval", message: "Allow delete_item to run?", answering: false,
      detail: { tool: "delete_item", arguments: "{\"id\":\"a\"}" } } as unknown as ChatInput;
    chat.show({
      messages: [
        user("go", 1),
        assistant([{ type: "toolCall", id: "c1", name: "ask_user", arguments: {} }, { type: "toolCall", id: "c2", name: "shop__delete_item", arguments: { id: "a" } }], 2, { stopReason: "toolUse" }),
        toolResult("c1", "Waiting for the user's input.", 3, { details: { inputRequired: true } }),
        toolResult("c2", "Waiting for the user's input.", 3, { details: { inputRequired: true } }),
      ],
    }, "input_required", [question, approval]);
    const group = screen.getByRole("group", { name: /Which region\?/ });
    const submit = screen.getByRole("button", { name: "Submit" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(group).getByRole("radio", { name: "US" }));
    await userEvent.click(submit);
    expect(chat.chat.answer).toHaveBeenCalledWith(question, { "Which region?": "US" });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(chat.chat.answer).toHaveBeenCalledWith(approval, true);
  });

  it("renders a tool with its own component (generative UI), args as they stream, and its result", () => {
    const chat = scripted();
    function Weather({ args, state, result }: ToolRenderProps) {
      return <div data-testid="weather">{String(args.city ?? "")}:{state}:{String((result?.data as { temp?: number } | undefined)?.temp ?? "")}</div>;
    }
    render(<AgentChat chat={chat.chat} tools={{ get_weather: Weather }} />);
    const call = (args: object) => ({ type: "toolCall", id: "w1", name: "weather__get_weather", arguments: args });
    chat.show({ messages: [user("weather?", 1)], running: true, partial: assistant([call({ city: "Par" })], 2) }, "streaming");
    expect(screen.getByTestId("weather").textContent).toBe("Par:input_streaming:");
    chat.show({ messages: [user("weather?", 1), assistant([call({ city: "Paris" })], 2, { stopReason: "toolUse" }), toolResult("w1", "{\"temp\":21}", 3)] });
    expect(screen.getByTestId("weather").textContent).toBe("Paris:done:21");
  });

  it("offers suggestions before the first message, and announces replies politely rather than token by token", async () => {
    const chat = scripted();
    render(<AgentChat chat={chat.chat} suggestions={["Where is my order?"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Where is my order?" }));
    expect(chat.chat.send).toHaveBeenCalledWith("Where is my order?");
    const status = screen.getByRole("status");
    const history = [user("hi", 1)];
    chat.show({ messages: history, running: true, partial: assistant([{ type: "text", text: "Hel" }], 2) }, "streaming");
    expect(status.textContent).toBe("The assistant is responding.");
    chat.show({ messages: history, running: true, partial: assistant([{ type: "text", text: "Hello the" }], 2) }, "streaming");
    expect(status.textContent).toBe("The assistant is responding.");
    chat.show({ messages: [...history, assistant([{ type: "text", text: "Hello there." }], 2)] }, "ready");
    expect(status.textContent).toBe("The assistant replied: Hello there.");
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
  });

  it("has no accessibility violations axe can find", async () => {
    const chat = scripted();
    const { container } = render(<AgentChat chat={chat.chat} suggestions={["Hi"]} />);
    const question = { id: "inp_q", toolCallId: "c1", kind: "question", message: "Pick", answering: false, detail: { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] } } as unknown as ChatInput;
    chat.show({
      messages: [user("go", 1), assistant([{ type: "text", text: "Sure. `code` and [a link](https://example.com)" }, { type: "toolCall", id: "c0", name: "js_exec", arguments: { code: "1" } }, { type: "toolCall", id: "c1", name: "ask_user", arguments: {} }], 2, { stopReason: "toolUse" }), toolResult("c0", "1", 3), toolResult("c1", "…", 3, { details: { inputRequired: true } })],
    }, "input_required", [question]);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.html).join(" | ")}`)).toEqual([]);
  });
});

describe("<Markdown>", () => {
  it("never renders unsafe links or raw HTML, and shows images only as links by default", () => {
    render(<Markdown text={"[x](javascript:alert(1)) <img src=x onerror=alert(1)> ![pixel](https://tracker.example/p.png)"} />);
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("pixel").closest("a")!.getAttribute("href")).toBe("https://tracker.example/p.png");
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });

  it("does not re-render blocks that did not change while the text streams", () => {
    const { rerender, container } = render(<Markdown text={"First paragraph.\n\nSec"} streaming />);
    const first = container.querySelector("p")!;
    const firstText = first.firstChild;
    rerender(<Markdown text={"First paragraph.\n\nSecond paragraph"} streaming />);
    expect(container.querySelector("p")).toBe(first);
    expect(container.querySelector("p")!.firstChild).toBe(firstText);
    fireEvent.click(container);
  });
});
