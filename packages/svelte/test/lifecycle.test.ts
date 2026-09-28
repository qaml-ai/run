// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { agentChat } from "../src/index.ts";
import { slowServer } from "../../test-lifecycle.ts";

describe("svelte lifecycle", () => {
  it("subscribe, unsubscribe, subscribe before the token arrives opens one stream", async () => {
    const server = slowServer();
    const stores = agentChat({ endpoint: "/api/agent", fetch: server.fetch });
    stores.status.subscribe(() => {})();
    const off = stores.status.subscribe(() => {});
    await vi.waitFor(() => expect(server.pending.length).toBe(2));
    server.pending[1](); await new Promise(resolve => setTimeout(resolve, 20)); server.pending[0]();
    await vi.waitFor(() => expect(server.open()).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.open()).toBe(1);
    off();
    await vi.waitFor(() => expect(server.open()).toBe(0));
  });
});
