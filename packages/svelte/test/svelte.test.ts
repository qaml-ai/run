// @vitest-environment jsdom
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { agentChat } from "../src/index.ts";
import { fakeChat } from "../../react/test/fake-chat.ts";

describe("svelte", () => {
  it("stores follow the chat, each notifying only when its part changes (Svelte's own get reads them)", () => {
    const fake = fakeChat();
    const stores = agentChat(fake.chat);
    const statuses: string[] = [];
    let messageRuns = 0;
    const offStatus = stores.status.subscribe(value => statuses.push(value));
    const offMessages = stores.messages.subscribe(() => messageRuns++);
    fake.set({ status: "streaming" });
    fake.set({ status: "ready" });
    expect(statuses).toEqual(["ready", "streaming", "ready"]);
    expect(messageRuns).toBe(1);
    expect(get(stores.status)).toBe("ready");
    offStatus(); offMessages();
    expect(fake.listeners).toBe(0);
  });

  it("a chat it makes connects with the first subscriber and disconnects after the last", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 }));
    const stores = agentChat({ endpoint: "/api/agent", fetch });
    expect(fetch).not.toHaveBeenCalled();
    let status = "";
    const off = stores.status.subscribe(value => { status = value; });
    await vi.waitFor(() => expect(status).toBe("error"));
    expect(fetch).toHaveBeenCalledTimes(1);
    off();
  });
});
