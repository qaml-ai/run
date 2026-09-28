import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { agentChat } from "../src/index.ts";

describe("svelte on the server (SvelteKit)", () => {
  it("reads a store without connecting", async () => {
    const fetch = vi.fn();
    expect(get(agentChat({ endpoint: "/api/agent", fetch }).status)).toBe("connecting");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
