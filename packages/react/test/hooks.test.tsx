import { StrictMode } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentProvider, useAgentSelector, useAgentStatus, useInputs, useMessages, useSend, useToolRenderer, useToolRendererFor,
  type ChatMessage, type ToolRenderProps,
} from "@camelai/agent-runtime-react";
import { fakeChat } from "./fake-chat.ts";

const message = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", id: `${id}:0`, text, streaming: false }], text, createdAt: 1, status: "sent" });

describe("hooks", () => {
  it("read the provider's chat, and re-render only when what they select changes", () => {
    const fake = fakeChat({ messages: [message("a", "hi")] });
    let renders = 0;
    function Messages() {
      renders++;
      return <ul>{useMessages().map(item => <li key={item.id}>{item.role === "user" ? item.text : ""}</li>)}</ul>;
    }
    render(<AgentProvider chat={fake.chat}><Messages /></AgentProvider>);
    expect(screen.getByText("hi")).toBeTruthy();
    const before = renders;
    act(() => fake.set({ status: "streaming" }));
    expect(renders).toBe(before);
    act(() => fake.set({ messages: [message("a", "hi"), message("b", "there")] }));
    expect(renders).toBe(before + 1);
    expect(screen.getByText("there")).toBeTruthy();
  });

  it("useAgentStatus says whether the agent works, with stop; useSend and useInputs call the chat", async () => {
    const fake = fakeChat({ status: "submitted" });
    const wrapper = ({ children }: { children: React.ReactNode }) => <AgentProvider chat={fake.chat}>{children}</AgentProvider>;
    const { result } = renderHook(() => ({ status: useAgentStatus(), send: useSend(), inputs: useInputs() }), { wrapper });
    expect(result.current.status.isRunning).toBe(true);
    await result.current.status.stop();
    expect(fake.chat.stop).toHaveBeenCalled();
    act(() => fake.set({ status: "ready" }));
    expect(result.current.status.isRunning).toBe(false);
    await result.current.send("hello", { data: { page: "/x" } });
    expect(fake.chat.send).toHaveBeenCalledWith("hello", { data: { page: "/x" } });
    await result.current.inputs.answer("inp_1", true);
    expect(fake.chat.answer).toHaveBeenCalledWith("inp_1", true);
  });

  it("a selector that changes with its arguments reads the new selection", () => {
    const fake = fakeChat({ messages: [message("a", "one"), message("b", "two")] });
    const wrapper = ({ children }: { children: React.ReactNode }) => <AgentProvider chat={fake.chat}>{children}</AgentProvider>;
    const { result, rerender } = renderHook(({ id }) => useAgentSelector(snapshot => snapshot.messages.find(item => item.id === id)), { wrapper, initialProps: { id: "a" } });
    expect(result.current?.id).toBe("a");
    rerender({ id: "b" });
    expect(result.current?.id).toBe("b");
  });

  it("tool renderers come from a component's own map, then useToolRenderer, then the provider", () => {
    const fake = fakeChat();
    const FromProvider = (_: ToolRenderProps) => null;
    const FromHook = (_: ToolRenderProps) => null;
    const FromProp = (_: ToolRenderProps) => null;
    const seen: unknown[] = [];
    function Probe({ register, prop }: { register: boolean; prop?: boolean }) {
      return <>{register && <Register />}<Read prop={prop} /></>;
    }
    function Register() { useToolRenderer("weather", FromHook); return null; }
    function Read({ prop }: { prop?: boolean }) { seen.push(useToolRendererFor("weather", prop ? { weather: FromProp } : undefined)); return null; }
    const { rerender } = render(<AgentProvider chat={fake.chat} tools={{ weather: FromProvider }}><Probe register={false} /></AgentProvider>);
    expect(seen.at(-1)).toBe(FromProvider);
    rerender(<AgentProvider chat={fake.chat} tools={{ weather: FromProvider }}><Probe register /></AgentProvider>);
    expect(seen.at(-1)).toBe(FromHook);
    rerender(<AgentProvider chat={fake.chat} tools={{ weather: FromProvider }}><Probe register prop /></AgentProvider>);
    expect(seen.at(-1)).toBe(FromProp);
    rerender(<AgentProvider chat={fake.chat} tools={{ weather: FromProvider }}><Probe register={false} /></AgentProvider>);
    expect(seen.at(-1)).toBe(FromProvider);
  });

  it("a provider with an endpoint connects its own chat while mounted, in StrictMode too, and a new thread is a new chat", async () => {
    const bodies: { action: string; thread?: string }[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in first" } }), { status: 401 });
    });
    function Status() { const { status, error } = useAgentStatus(); return <p>{status}:{error?.code ?? ""}</p>; }
    const { rerender, unmount } = render(<StrictMode><AgentProvider endpoint="/api/agent" fetch={fetch as typeof globalThis.fetch}><Status /></AgentProvider></StrictMode>);
    await waitFor(() => expect(screen.getByText("error:unauthorized")).toBeTruthy());
    expect(bodies.every(body => body.action === "token" && body.thread === undefined)).toBe(true);
    rerender(<StrictMode><AgentProvider endpoint="/api/agent" thread="t2" fetch={fetch as typeof globalThis.fetch}><Status /></AgentProvider></StrictMode>);
    await waitFor(() => expect(bodies.some(body => body.thread === "t2")).toBe(true));
    unmount();
  });

  it("hooks outside a provider say so", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useMessages())).toThrow(/AgentProvider/);
    spy.mockRestore();
  });
});

