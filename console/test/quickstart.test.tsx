import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickstartPage } from "../web/pages/quickstart";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.startsWith("/v1/models") ? json([{ id: "openrouter/some-model" }]) : json({})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const code = () => [...document.querySelectorAll("pre code")].map(block => block.textContent ?? "");

describe("QuickstartPage", () => {
  it("leads with the coding-agent prompt and the no-key MCP path, at this console's origin", () => {
    render(<QuickstartPage />);
    const blocks = code();
    expect(blocks[0]).toBe(`Read ${location.origin}/SKILL.md and set up camelRun in this project.`);
    expect(blocks[1]).toContain(`claude mcp add --transport http camelrun ${location.origin}/mcp`);
    expect(blocks[1]).toContain(`codex mcp add camelrun --url ${location.origin}/mcp`);
    expect(screen.queryByText(/First add a model key/)).toBeNull();
  });

  it("names no model in the examples, so agents get the account's default; choosing one is a separate, optional step", async () => {
    render(<QuickstartPage />);
    // The TypeScript tab is the one shown.
    const typescript = code().find(block => block.includes('agents.upsert("quickstart", {\n'))!;
    expect(typescript).toContain('instructions: "You are a concise assistant."');
    expect(typescript).not.toMatch(/model:/);
    expect(await screen.findByText(/model: "openrouter\/some-model"/)).toBeTruthy();
    expect(screen.getByText("Optional: choose a model")).toBeTruthy();
  });
});
