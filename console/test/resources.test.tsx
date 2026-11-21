import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BillingPage } from "../web/pages/billing";
import { ChannelsPage } from "../web/pages/channels";
import { DefinitionsPage } from "../web/pages/definitions";
import { ModelsPage } from "../web/pages/models";
import { ReposPage } from "../web/pages/repos";
import { TokensPage } from "../web/pages/tokens";
import { WebhooksPage } from "../web/pages/webhooks";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("v2 console resource pages", () => {
  it("renders TokensPage from /console/v2/tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          tokens: [{ id: "key_1", name: "Backend", prefix: "cr_live_tnt_1.abc_1234...", scopes: ["*"], createdAt: Date.now(), lastUsedAt: null }],
        }),
      ),
    );
    render(<TokensPage tenant="tnt_1234567890abcdef" />);
    expect(await screen.findByText("Backend")).toBeTruthy();
    expect(screen.getByText("cr_live_tnt_1.abc_1234...")).toBeTruthy();
  });

  it("renders ModelsPage from /console/v2/providers and /console/v2/models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path.includes("/providers")) return json({ providers: [{ provider: "anthropic", baseUrl: null, apiStyle: null, updatedAt: Date.now() }] });
        if (path.includes("/models")) {
          return json([
            { id: "anthropic/claude-sonnet-4-0", provider: "anthropic", modelId: "claude-sonnet-4-0", reasoning: true, maxTokens: 64000, input: ["text", "image"], cost: { input: 3, output: 15 }, available: true },
          ]);
        }
        return json({});
      }),
    );
    render(<ModelsPage />);
    expect(await screen.findByText("anthropic/claude-sonnet-4-0")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
  });

  it("renders DefinitionsPage, ReposPage, ChannelsPage, WebhooksPage, and BillingPage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/console/v2/definitions") {
          return json({ definitions: [{ slug: "support-v2", config: { model: "openai/gpt-5", builtins: ["files"] }, createdAt: 1, updatedAt: 2 }] });
        }
        if (path === "/console/v2/repos") {
          return json({ repos: [{ repoId: "repo_abc", name: "workspace-main", lineage: "lin_1", defaultRef: "refs/heads/main", commit: "abcdef123456", createdAt: 1 }] });
        }
        if (path === "/console/v2/channels") {
          return json({ channels: [{ id: "ch_tnt_1.aabbcc", kind: "http", name: "Support Webhook", definition: "support-v2", outboundUrl: null, createdAt: 1 }] });
        }
        if (path === "/console/v2/webhooks") {
          return json({ webhooks: [{ id: "wh_1", url: "https://hooks.example.com/cr", events: ["run_completed"], enabled: true, createdAt: 1 }] });
        }
        return json({});
      }),
    );

    render(<DefinitionsPage />);
    expect(await screen.findByText("support-v2")).toBeTruthy();
    cleanup();

    render(<ReposPage />);
    expect(await screen.findByText("workspace-main")).toBeTruthy();
    cleanup();

    render(<ChannelsPage />);
    expect(await screen.findByText("Support Webhook")).toBeTruthy();
    cleanup();

    render(<WebhooksPage />);
    expect(await screen.findByText("https://hooks.example.com/cr")).toBeTruthy();
    cleanup();

    render(
      <BillingPage
        me={{ tenantId: "tnt_1", tenant: "tnt_1", name: "Acme", balanceUsd: 25, tier: "pro", busyAgents: { active: 1, limit: 25 } }}
        billing={{
          data: {
            balanceUsd: 25,
            monthlyCapUsd: 1000,
            tier: "pro",
            rateLimitRpm: 600,
            busyAgents: { busy: 1, limit: 25 },
            usage: [],
            recent: [{ id: "led_1", refId: "initial_grant", amountUsd: 25, kind: "grant", note: "Initial credits", createdAt: Date.now() }],
          },
          error: undefined,
          loading: false,
          reload: async () => {},
        }}
      />,
    );
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.getByText("Initial credits")).toBeTruthy();
  });
});
