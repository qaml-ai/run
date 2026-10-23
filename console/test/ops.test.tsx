import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminAcquisition } from "../../src/admin-acquisition";
import type { AdminMcp } from "../../src/admin-mcp";
import type { AdminGrowth } from "../../src/admin-growth";
import type { AdminRevenue } from "../../src/admin-revenue";
import type { AdminAccountDetail, AdminUsage } from "../../src/admin-usage";
import { TooltipProvider } from "../web/components/ui/tooltip";
import { resetOps } from "../web/lib/ops";
import { OpsPage } from "../web/pages/ops/ops-page";

const NOW = "2026-10-16T15:00:00Z";
const range = (days: number) => ({ days, start_date: "2026-10-10", end_date: "2026-10-16", previous_start_date: "2026-10-03", incomplete_date: "2026-10-16", time_zone: "UTC" as const });
const DATES = ["2026-10-14", "2026-10-15", "2026-10-16"];
const USD = 1_000_000;

const growth = (days: number): AdminGrowth => ({
  schema_version: 1, range: range(days), generated_at: NOW, accounts: 159,
  tiles: { signups: { current: 59, previous: 50 }, activated: { current: 33, previous: 30 }, weekly_active: { current: 31, previous: 28 }, weekly_returning: { current: 25, previous: 20 } },
  daily: DATES.map((date, index) => ({ date, signups: index + 2, github: index + 1, google: 1, email: 0, active_new: 1, active_returning: 4, accounts: 150 + index })),
  sign_in: { github: 6, google: 3, email: 0 },
  funnel: { signed_up: 59, made_agent: 40, ran_model: 33, came_back: 22 }, previous_funnel: { signed_up: 50, made_agent: 30, ran_model: 30, came_back: 20 },
  median_days_to_first_run: 1, cohorts: [{ week: "2026-10-05", size: 10, active: [6, 3] }, { week: "2026-10-12", size: 4, active: [2] }],
});
const acquisition = (days: number): AdminAcquisition => ({
  schema_version: 1, range: range(days), generated_at: NOW, status: "not_configured", tracked_signups: 0, sources: [{ source: "Not captured", medium: null, signups: 9, made_agent: 4, activated: 3, active_two_days: 2, paying: 1, median_days_to_first_run: 0 }], campaigns: [], landing_pages: [],
  total: { source: "All", medium: null, signups: 9, made_agent: 4, activated: 3, active_two_days: 2, paying: 1, median_days_to_first_run: 0 },
  daily: DATES.map((date, index) => ({ date, counts: [index + 2] })),
  truncated: false, coverage: { first_event_at: null, last_event_at: null },
});
const usage = (days: number): AdminUsage => ({
  schema_version: 1, range: range(days), generated_at: NOW,
  tiles: {
    active_accounts: { current: 12, previous: 9 }, responses: { current: 900, previous: 700 }, self_serve_responses: { current: 300, previous: 200 },
    agents_ran: { current: 20, previous: 0 }, self_serve_agents_ran: { current: 8, previous: 0 }, end_users: { current: 40, previous: 0 }, self_serve_end_users: { current: 5, previous: 0 }, live_agents: 30, self_serve_live_agents: 14,
  },
  daily: DATES.map(date => ({ date, self_serve: 100, operator: 200, other: 0 })),
  attempts_since: "2026-10-13T09:00:00Z",
  models: [{ model: "anthropic/claude-sonnet-4-5", responses: 300, accounts: 5, cost: 3, self_serve_responses: 300, self_serve_accounts: 5 }],
  configured_models: [{ model: "anthropic/claude-sonnet-4-5", agents: 14, accounts: 9, self_serve_agents: 14, self_serve_accounts: 9 }],
  features: [{ key: "web_search", label: "Web search", agents: 7, self_serve_agents: 7 }],
  integrations: [{ key: "slack", label: "Slack", accounts: 2, self_serve_accounts: 2 }],
  mcp_clients: [{ client: "Claude", accounts: 1 }],
  accounts: [
    { tenant: "camelbot", name: "camelbot", kind: "operator", sign_in: null, signed_up_at: null, staff: false, deleted: false, agents: 5, responses: 600, cost: 6, platform_cost: 6, active_days: 3, last_active: "2026-10-16", models: ["openrouter/openai/gpt-5"], balance: null, purchased: 0 },
    { tenant: "ann", name: "ann", kind: "self_serve", sign_in: "github", signed_up_at: "2026-10-01T10:00:00Z", staff: false, deleted: false, agents: 1, responses: 300, cost: 3, platform_cost: 3, active_days: 3, last_active: "2026-10-15", models: ["anthropic/claude-sonnet-4-5"], balance: 4.4 * USD, purchased: 0 },
  ],
  agents: [],
});
const ann: AdminAccountDetail = {
  schema_version: 1, range: range(30), generated_at: NOW,
  account: { tenant: "ann", name: "ann", kind: "self_serve", sign_in: "github", signed_up_at: "2026-10-01T10:00:00Z", staff: false, deleted: false, billing: "prepaid", balance: 4.4 * USD, purchased: 0, granted: 5 * USD },
  usage: { responses: 300, cost: 3, platform_cost: 3, active_days: 3, models: [{ model: "anthropic/claude-sonnet-4-5", responses: 300, cost: 3 }] },
  daily: DATES.map(date => ({ date, responses: 100 })),
  agents: [{
    agent: "ann-bot", name: "Research helper", type: "general", model: "anthropic/claude-sonnet-4-5", definition: null, builtins: ["web_search"], mcp_servers: ["mcp.example.test"],
    openapi: 0, app_tools: 0, code_mode: true, schedules: 1, channel: null, responses: 300, end_users: 1, last_at: "2026-10-16T10:00:00Z",
    system_prompt: `You are Ann's research helper. ${"Read carefully. ".repeat(200)}`.slice(0, 1500), system_prompt_length: 3231,
  }],
  live_agents: 1, channels: [], counts: { api_keys: 1, definitions: 0, volumes: 0, schedules: 1 }, provider_keys: [], mcp_clients: ["Claude"],
};
const revenue = (days: number): AdminRevenue => ({
  schema_version: 1, range: range(days), generated_at: NOW,
  tiles: { revenue: { current: 0, previous: 0 }, refunds: { current: 0, previous: 0 }, buyers: { current: 0, previous: 0 }, first_purchases: { current: 0, previous: 0 }, paying_accounts: 0, auto_topup: 0, outstanding_purchased: 0, outstanding_free: 4.4 * USD },
  daily: DATES.map(date => ({ date, purchases: 0, amount: 0, refunds: 0 })),
  monthly: [{ month: "2026-10", amount: 0, refunds: 0, buyers: 0 }],
  spend: { paying_charged: 0, paying_provider_cost: 0, free_charged: 0.6 * USD, free_provider_cost: 0.5 },
  free_credit: {
    accounts: 1, given: 5 * USD, used: 0.6 * USD, buckets: { untouched: 0, tried: 1, using: 0, nearly_out: 0, used_up: 0 }, used_any: 1, bought: 0, without: 0,
    decisions: { eligible: 1, ineligible: 0, disabled: 0, legacy: 0, card_unlocked: 0 }, provider_cost: 0.5, rows: [],
  },
});

let requests: string[] = [];
let sourceReport: AdminAcquisition | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  requests = [];
  sourceReport = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    const { pathname, searchParams } = new URL(url, "http://ops.test");
    const days = Number(searchParams.get("days") ?? 30);
    if (pathname === "/api/me") return Response.json({ viewer: "ops@example.test" });
    if (pathname === "/api/growth") return Response.json(growth(days));
    if (pathname === "/api/acquisition") return Response.json(sourceReport ?? acquisition(days));
    if (pathname === "/api/mcp") return Response.json({
      schema_version: 1, range: range(days), generated_at: NOW,
      daily: [{ date: "2026-10-16", kind: "chatgpt", signups: 3, token_active_accounts: 2 }],
      weekly: [{ week: "2026-10-12", kind: "chatgpt", token_active_accounts: 2 }],
      funnel: [{ kind: "chatgpt", label: "ChatGPT plugin", authorized: 3, made_agent: 2, ran_turn: 1, came_back: 0 }],
      limitations: ["Latest token issuance or refresh only; not MCP request activity."],
    } satisfies AdminMcp);
    if (pathname === "/api/usage") return Response.json(usage(days));
    if (pathname === "/api/revenue") return Response.json(revenue(days));
    if (pathname === "/api/account" && searchParams.get("tenant") === "ann") return Response.json(ann);
    return Response.json({ error: "Not found" }, { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  resetOps();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

const page = (search = "") => {
  history.replaceState(null, "", `/ops/${search}`);
  return render(<TooltipProvider><OpsPage /></TooltipProvider>);
};

test("the tab and the range are read from the address and kept in it", async () => {
  const user = userEvent.setup();
  page("?tab=revenue&days=7");
  expect(screen.getByRole("tab", { name: "Revenue" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed")).toBe("true");
  await screen.findByText(/No purchases in the last 7 days yet/);
  expect(requests).toContain("/api/revenue?days=7");

  await user.click(screen.getByRole("tab", { name: "Growth" }));
  await user.click(screen.getByRole("button", { name: "90 days" }));
  await waitFor(() => expect(new URLSearchParams(location.search).get("days")).toBe("90"));
  expect(new URLSearchParams(location.search).get("tab")).toBe("growth");
  expect(location.pathname).toBe("/ops/");
  await waitFor(() => expect(requests).toContain("/api/growth?days=90"));
  expect(document.title).toBe("camelRun ops");
});

test("growth shows its headline figures, the takeaway, and why sources are missing", async () => {
  page();
  await screen.findByText(/159 self-serve accounts\. 59 signed up in the last 30 days; 31 did work this week\./);
  expect(screen.getByText("Signed in as")).toBeTruthy();
  const signups = screen.getByText("Sign-ups", { selector: "dt" }).closest("div")!;
  expect(within(signups).getByText("59")).toBeTruthy();
  expect(within(signups).getByText("+18%")).toBeTruthy();
  expect(within(screen.getByText("Activated", { selector: "dt" }).closest("div")!).getByText("56% of them ran a model")).toBeTruthy();
  // The journey store is not connected here: the card says so in plain words, never a zero.
  const sources = (await screen.findAllByText(/Source reporting is not connected/))[0];
  expect(sources.textContent).toContain("Signup and usage counts still include all outside accounts");
  expect(new URLSearchParams(location.search).get("tab")).toBe("growth");
  expect(new URLSearchParams(location.search).get("days")).toBe("30");
});

test("a chart's numbers can be read as a table", async () => {
  const user = userEvent.setup();
  page();
  const card = (await screen.findByRole("heading", { name: "Sign-ups, by where they came from" })).closest("div.bg-card") as HTMLElement;
  await user.click(within(card).getAllByRole("button", { name: "Table view" })[0]);
  const table = within(card).getByRole("table");
  const rows = within(table).getAllByRole("row");
  expect(rows[0].textContent).toBe("Day (UTC)Sign-upsNot captured");
  // Newest first, today marked as still going.
  expect(rows[1].textContent).toBe("Oct 16 · today, so far44");
  expect(rows[3].textContent).toBe("Oct 1422");
});

test("an account opens from Top accounts and shows its agents' setup and the start of their prompts", async () => {
  const user = userEvent.setup();
  page("?tab=usage");
  // Self-serve only by default: camelBot is in the answer but not the table until the switch is on.
  const top = (await screen.findByRole("heading", { name: /^Top accounts/ })).closest("div.bg-card") as HTMLElement;
  await within(top).findByText("ann");
  expect(within(top).queryByText("camelbot")).toBeNull();
  // Per-agent figures began within the range: no change against a period that was not recorded.
  const ran = screen.getByText("Agents that ran", { selector: "dt" }).closest("div")!;
  expect(within(ran).getByText(/Nothing to compare with yet/)).toBeTruthy();
  expect(within(ran).getByText(/Counted from Oct 13, 2026/)).toBeTruthy();

  await user.click(within(top).getByText("ann"));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Research helper");
  expect(requests).toContain("/api/account?tenant=ann&days=30");
  expect(within(dialog).getByText(/Signed up Oct 1, 2026 with GitHub/)).toBeTruthy();
  await user.click(within(dialog).getByText("Research helper"));
  expect(within(dialog).getByText(/the first 1,500 of 3,231 characters/)).toBeTruthy();
  expect(within(dialog).getByText(/^You are Ann's research helper\./).tagName).toBe("PRE");
  expect(within(dialog).getByText(/MCP: mcp\.example\.test/)).toBeTruthy();

  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("switch"));
  expect(within(top).getByText("camelbot")).toBeTruthy();
});

test("MCP plugins shows attribution and token activity with the shared range and refresh", async () => {
  const user = userEvent.setup();
  page("?tab=mcp&days=7");
  expect(await screen.findByText("ChatGPT plugin")).toBeTruthy();
  expect(screen.getByText("Latest token issuance or refresh only; not MCP request activity.")).toBeTruthy();
  expect(requests).toContain("/api/mcp?days=7");
  await user.click(screen.getByRole("button", { name: "30 days" }));
  await waitFor(() => expect(requests).toContain("/api/mcp?days=30"));
  const before = requests.filter(path => path === "/api/mcp?days=30").length;
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(requests.filter(path => path === "/api/mcp?days=30").length).toBe(before + 1));
});


test("sources show conversion rates and daily stacks retain every source in table view", async () => {
  const user = userEvent.setup();
  sourceReport = acquisition(30);
  sourceReport.status = "ok";
  sourceReport.sources = ["newsletter", "blog", "docs", "camelai.com/blog/ai-agent-memory", "camelai.com/blog/deploy-ai-agents", "camelai.com/", "ChatGPT plugin", "Not captured"].map((source, index) => ({
    source, medium: null, signups: index + 1, made_agent: 1, activated: 1, active_two_days: 0, paying: 0, median_days_to_first_run: 0,
  }));
  sourceReport.total.signups = 36;
  sourceReport.daily = [{ date: "2026-10-16", counts: [1, 2, 3, 4, 5, 6, 7, 8] }];
  page();
  const table = await screen.findByRole("table", { name: "Sign-ups of the last 30 days by source" });
  expect(within(table).getByText("Active 2+ days")).toBeTruthy();
  expect(within(table).getAllByRole("row")).toHaveLength(10);
  const blog = within(table).getByText("blog").closest("tr")!;
  expect(blog.textContent).toContain("1 (50%)");
  const chart = screen.getByRole("heading", { name: "Sign-ups, by where they came from" }).closest("div.bg-card") as HTMLElement;
  expect(within(chart).getByText("Other")).toBeTruthy();
  expect(within(chart).getByText("ChatGPT plugin")).toBeTruthy();
  within(chart).getByRole("group", { name: /Sign-ups by source:/ }).focus();
  await user.keyboard("{End}");
  const readout = within(chart).getByRole("presentation");
  const readoutRows = Array.from(readout.children).slice(1);
  expect(readoutRows[0].textContent).toBe("36in all");
  expect(readoutRows.slice(-3).map(element => element.textContent)).toEqual([
    "6/", "5/blog/deploy-ai-agents", "4/blog/ai-agent-memory",
  ]);
  expect(readoutRows.slice(-3).every(element => element.classList.contains("text-muted-foreground/70"))).toBe(true);
  expect(chart.textContent).not.toContain("Other:");
  expect(table.textContent).not.toContain("camelai.com");
  await user.click(within(chart).getByRole("button", { name: "Table view" }));
  const daily = within(chart).getByRole("table");
  expect(within(daily).getByText("/")).toBeTruthy();
  expect(within(daily).getByText("36")).toBeTruthy();
});
