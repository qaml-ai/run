import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleNav } from "../web/components/console-nav";
import { ACCOUNT_NAV, PRIMARY_NAV, documentTitle, groupOf, redirectFor } from "../web/lib/nav";

afterEach(() => cleanup());

describe("v2 console navigation", () => {
  it("exposes primary and account nav groups without dead v1-only screens", () => {
    expect(PRIMARY_NAV.map(i => i.label)).toEqual(["Overview", "Agents", "Definitions", "Usage"]);
    expect(ACCOUNT_NAV.map(i => i.label)).toEqual([
      "Channels",
      "Webhooks",
      "Repositories",
      "API keys",
      "Models & keys",
      "Billing",
      "Settings",
    ]);
    expect(groupOf("")?.label).toBe("Overview");
    expect(groupOf("repos")?.label).toBe("Repositories");
    expect(groupOf("webhooks")?.label).toBe("Webhooks");
    expect(groupOf("account")?.label).toBe("Settings");
  });

  it("titles browser tabs cleanly", () => {
    expect(documentTitle("agents")).toBe("Agents · camelRun");
    expect(documentTitle("repos")).toBe("Repositories · camelRun");
    expect(documentTitle("", true)).toBe("Get started · camelRun");
  });

  it("redirects legacy v1 paths cleanly to v2 destinations", () => {
    expect(redirectFor("volumes", "")).toBe("repos");
    expect(redirectFor("volumes/repo_123", "")).toBe("repos/repo_123");
    expect(redirectFor("settings", "")).toBe("account");
    expect(redirectFor("telemetry", "")).toBe("account");
    expect(redirectFor("overview", "")).toBe("");
    expect(redirectFor("inbox", "")).toBe("agents");
    expect(redirectFor("workspaces", "")).toBe("");
    expect(redirectFor("computers", "")).toBe("");
    expect(redirectFor("agents", "")).toBeUndefined();
  });

  it("renders sidebar links with /console/ base URLs", () => {
    render(<ConsoleNav active="agents" start={{ place: "top" }} />);
    expect(screen.getByRole("link", { name: "Agents" }).getAttribute("href")).toBe("/console/agents");
    expect(screen.getByRole("link", { name: "Repositories" }).getAttribute("href")).toBe("/console/repos");
    expect(screen.getByRole("link", { name: "Webhooks" }).getAttribute("href")).toBe("/console/webhooks");
    expect(screen.getByRole("link", { name: "API keys" }).getAttribute("href")).toBe("/console/tokens");
  });
});
