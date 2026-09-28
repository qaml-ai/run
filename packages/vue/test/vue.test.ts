import { effectScope, nextTick, watch } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/index.ts";
import { fakeChat } from "../../react/test/fake-chat.ts";

const message = (id: string) => ({ id, role: "user" as const, parts: [], text: id, createdAt: 1, status: "sent" as const });

describe("vue", () => {
  it("refs follow the chat, each changing only with its part; the scope's end unsubscribes", async () => {
    const fake = fakeChat({ messages: [message("a")] });
    const scope = effectScope();
    const chat = scope.run(() => useAgentChat(fake.chat))!;
    const seen: string[] = [];
    scope.run(() => { watch(chat.messages, () => seen.push("messages")); watch(chat.status, () => seen.push("status")); });
    fake.set({ status: "streaming" });
    await nextTick();
    expect(seen).toEqual(["status"]);
    fake.set({ messages: [message("a"), message("b")] });
    await nextTick();
    expect(chat.messages.value.map(item => item.id)).toEqual(["a", "b"]);
    await chat.send("hi");
    expect(fake.chat.send).toHaveBeenCalledWith("hi");
    scope.stop();
    expect(fake.listeners).toBe(0);
    expect(fake.chat.destroy).not.toHaveBeenCalled();
  });

  it("a chat it makes connects at once and is destroyed with the scope", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 }));
    const scope = effectScope();
    const chat = scope.run(() => useAgentChat({ endpoint: "/api/agent", fetch }))!;
    await vi.waitFor(() => expect(chat.status.value).toBe("error"));
    expect(chat.error.value?.code).toBe("unauthorized");
    scope.stop();
  });
});
