import { vi } from "vitest";
import type { AgentChat, ChatSnapshot } from "@camelai/run/chat";

export const EMPTY: ChatSnapshot = { status: "ready", messages: [], inputs: [], error: null, hasOlder: false, connected: true, agentId: "client_x" };

/** A chat whose snapshot a test sets, and whose actions record their calls. */
export function fakeChat(initial: Partial<ChatSnapshot> = {}) {
  let snapshot: ChatSnapshot = { ...EMPTY, ...initial };
  const listeners = new Set<() => void>();
  const chat: AgentChat = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send: vi.fn(async () => ({ id: "cm_sent" })),
    retry: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    decline: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    loadOlder: vi.fn(async () => false),
    fileUrl: vi.fn(async (path: string) => `https://files.test${path}`),
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    chat,
    set(next: Partial<ChatSnapshot>) { snapshot = { ...snapshot, ...next }; for (const listener of [...listeners]) listener(); },
    get listeners() { return listeners.size; },
  };
}
