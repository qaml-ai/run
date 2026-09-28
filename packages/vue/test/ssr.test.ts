import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/index.ts";

describe("vue on the server (Nuxt)", () => {
  it("renders without connecting", async () => {
    const fetch = vi.fn();
    const Chat = defineComponent({ setup() { const { status } = useAgentChat({ endpoint: "/api/agent", fetch }); return () => h("p", status.value); } });
    expect(await renderToString(createSSRApp(Chat))).toBe("<p>connecting</p>");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });
});
