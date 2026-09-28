// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/index.ts";
import { slowServer } from "../../test-lifecycle.ts";

describe("solid lifecycle", () => {
  it("connects when mounted; disposed before the token arrives, it opens nothing", async () => {
    const server = slowServer();
    const dispose = createRoot(dispose => { useAgentChat({ endpoint: "/api/agent", fetch: server.fetch }); return dispose; });
    await vi.waitFor(() => expect(server.pending.length).toBe(1));
    dispose();
    server.pending[0]();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.streams.length).toBe(0);
    const again = createRoot(dispose => { useAgentChat({ endpoint: "/api/agent", fetch: server.fetch }); return dispose; });
    await vi.waitFor(() => expect(server.pending.length).toBe(2));
    server.pending[1]();
    await vi.waitFor(() => expect(server.open()).toBe(1));
    again();
    await vi.waitFor(() => expect(server.open()).toBe(0));
  });
});
