// @vitest-environment jsdom
import { createApp, defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/index.ts";
import { slowServer } from "../../test-lifecycle.ts";

describe("vue lifecycle", () => {
  it("connects when mounted, and an unmount before the token arrives opens nothing", async () => {
    const server = slowServer();
    const Chat = defineComponent({ setup() { useAgentChat({ endpoint: "/api/agent", fetch: server.fetch }); return () => h("div"); } });
    const host = document.createElement("div");
    const app = createApp(Chat);
    app.mount(host);
    await vi.waitFor(() => expect(server.pending.length).toBe(1));
    app.unmount();
    server.pending[0]();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.streams.length).toBe(0);
    // Mounted and left mounted: one stream, closed on unmount.
    const again = createApp(Chat);
    again.mount(document.createElement("div"));
    await vi.waitFor(() => expect(server.pending.length).toBe(2));
    server.pending[1]();
    await vi.waitFor(() => expect(server.open()).toBe(1));
    again.unmount();
    await vi.waitFor(() => expect(server.open()).toBe(0));
  });
});
