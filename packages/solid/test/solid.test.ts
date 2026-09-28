// @vitest-environment jsdom
import { createEffect, createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/index.ts";
import { fakeChat } from "../../react/test/fake-chat.ts";

describe("solid", () => {
  it("signals follow the chat, each changing only with its part; disposal unsubscribes", async () => {
    const fake = fakeChat();
    const seen: string[] = [];
    const dispose = createRoot(dispose => {
      const chat = useAgentChat(fake.chat);
      createEffect(() => { chat.messages(); seen.push("messages"); });
      createEffect(() => { seen.push(`status:${chat.status()}`); });
      return dispose;
    });
    await Promise.resolve();
    seen.length = 0;
    fake.set({ status: "streaming" });
    await Promise.resolve();
    expect(seen).toEqual(["status:streaming"]);
    dispose();
    expect(fake.listeners).toBe(0);
  });

  it("a chat it makes connects at once", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 }));
    await createRoot(async dispose => {
      const chat = useAgentChat({ endpoint: "/api/agent", fetch });
      await vi.waitFor(() => expect(chat.status()).toBe("error"));
      dispose();
    });
  });
});
