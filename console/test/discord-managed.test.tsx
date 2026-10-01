import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelsPage } from "../web/pages/channels";
import { ManagedDiscord, ManagedDiscordDialog } from "../web/pages/discord-managed";
import { consoleLoginUrl, discordInstallNext } from "../web/lib/discord-setup";
import type { Channel, ManagedDiscordBinding } from "../web/lib/api";

const guildId = "123456789012345678";
const channelId = "234567890123456789";
const config = { enabled: true, applicationId: "345678901234567890", installPath: "/console/discord/install", limits: { servers: 10, turnsPerDay: 10_000 } };
const channel: Channel = { id: "ch-managed", type: "discord-managed", name: "Team", definition: "definition-1", access: { public: false, allow: ["456789012345678901"] }, limits: { perSenderPerMinute: 10, turnsPerDay: 100 }, account: { id: config.applicationId, username: "Camel" }, credentials: {}, createdAt: 1 };
const binding: ManagedDiscordBinding = { guildId, guildName: "Team server", state: "active", installationState: "present", channelId: channel.id, allowedChannelIds: [channelId], channel };
const fresh: ManagedDiscordBinding = { guildId, guildName: "Team server", state: "paused", installationState: "present", channelId: null, allowedChannelIds: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: any; headers?: Headers }[];
let enabled: boolean;
let managedBindings: ManagedDiscordBinding[];
let listedChannels: Channel[];
let responseBinding: ManagedDiscordBinding;
beforeEach(() => {
  calls = []; enabled = true; managedBindings = []; listedChannels = [];
  responseBinding = binding;
  vi.stubGlobal("location", { ...location, pathname: "/console/channels", search: "" });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: new Headers(init?.headers) });
    if (path === "/console/discord/config") return json({ ...config, enabled });
    if (path === `/console/discord/guilds/${guildId}/channels`) return json({ channels: [{ id: channelId, name: "camel-test", type: 0 }] });
    if (path === "/v1/definitions") return json([{ id: "definition-1", name: "Helpful assistant", model: "model-1", revision: 1, createdAt: 1, updatedAt: 1 }]);
    if (path === "/v1/channels") return json(listedChannels);
    if (path === "/console/discord/bindings") return json({ bindings: managedBindings });
    if (path === `/console/discord/bindings/${guildId}`) return json(responseBinding);
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("managed Discord console", () => {
  it("keeps customer token onboarding available and hides managed setup when disabled", async () => {
    enabled = false;
    listedChannels = [{ ...channel, id: "own-bot", type: "discord", name: "My bot", credentials: { botToken: "•••last4" } }];
    render(<ChannelsPage />);
    await screen.findByText("My bot");
    expect(screen.queryByRole("link", { name: /Add Camel to Discord/ })).toBeNull();
    expect(screen.getByRole("button", { name: /New channel/ })).toBeTruthy();
    expect(calls.some(call => call.path === "/console/discord/bindings")).toBe(false);
  });

  it("adds Camel through one Discord authorization, beside the bring-your-own-bot flow", async () => {
    render(<ChannelsPage />);
    const add = await screen.findByRole("link", { name: /Add Camel to Discord/ });
    expect(add.getAttribute("href")).toBe("/console/discord/install");
    fireEvent.click(screen.getByRole("button", { name: "Connect your own bot" }));
    await screen.findByText("New Discord channel");
    expect(screen.getByLabelText("Bot token")).toBeTruthy();
  });

  it("opens the server just added and requires explicit channels and members before activation", async () => {
    managedBindings = [fresh];
    vi.stubGlobal("location", { ...location, pathname: "/console/channels", search: `?discord_server=${guildId}` });
    render(<ChannelsPage />);
    await screen.findByText("Set up Camel in Team server");
    const checkbox = await screen.findByRole("checkbox", { name: "#camel-test" });
    const save = screen.getByRole("button", { name: "Save and activate" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(checkbox);
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Allowed member IDs"), { target: { value: "456789012345678901" } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText("Team server configured");
    const write = calls.find(call => call.method === "PATCH")!;
    expect(write.path).toBe(`/console/discord/bindings/${guildId}`);
    expect(write.headers?.get("X-Agent-Runtime-Console")).toBe("1");
    expect(write.body).toEqual({ definition: "definition-1", allowedChannelIds: [channelId], access: { public: false, allow: ["456789012345678901"] }, limits: { perSenderPerMinute: 5, turnsPerDay: 100 } });
    expect(screen.getByLabelText("Camel Discord test message").getAttribute("value")).toBe(`<@${config.applicationId}> status`);
    expect(calls.some(call => call.path === "/v1/channels" && call.method !== "GET")).toBe(false);
  });

  it("shows why adding Camel failed", async () => {
    vi.stubGlobal("location", { ...location, pathname: "/console/channels", search: `?discord_error=${encodeURIComponent("This Discord server is connected to another camelRun account")}` });
    render(<ChannelsPage />);
    expect(await screen.findByText(/connected to another camelRun account/)).toBeTruthy();
  });

  it("pauses through the server's binding rather than generic channel mutations", async () => {
    managedBindings = [binding];
    render(<ManagedDiscord config={config} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(calls.some(call => call.method === "PATCH")).toBe(true));
    expect(calls.find(call => call.method === "PATCH")).toMatchObject({ path: `/console/discord/bindings/${guildId}`, body: { state: "paused" } });
  });

  it("reactivates a disconnected server explicitly, and offers to add Camel again once removed", async () => {
    managedBindings = [{ ...binding, state: "disconnected", installationState: "removed" }];
    render(<ManagedDiscord config={config} onChanged={vi.fn()} />);
    expect((await screen.findByRole("link", { name: "Add it again" })).getAttribute("href")).toBe(`/console/discord/install?guild_id=${guildId}`);
    cleanup();
    render(<ManagedDiscordDialog config={config} binding={{ ...binding, state: "disconnected" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "Save and reactivate" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText("Team server configured");
    expect(calls.find(call => call.method === "PATCH")!.body.state).toBe("active");
  });

  it("caps daily turns at the account's limit", async () => {
    render(<ManagedDiscordDialog config={{ ...config, limits: { servers: 1, turnsPerDay: 500 } }} binding={binding} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((await screen.findByLabelText("Turns per server per day")).getAttribute("max")).toBe("500");
  });

  it("shows existing conversation apply outcomes and preserves paused state", async () => {
    responseBinding = { ...binding, state: "paused", applied: [{ agent: "a1", status: "updated" }, { agent: "a2", status: "queued" }, { agent: "a3", status: "failed", error: "Agent is unavailable" }] };
    render(<ManagedDiscordDialog config={config} binding={{ ...binding, state: "paused" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const save = screen.getByRole("button", { name: "Save configuration" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText("Team server configured");
    expect(screen.getByText(/1 updated · 1 queued · 1 failed/)).toBeTruthy();
    expect(screen.getByText(/Agent is unavailable/)).toBeTruthy();
    expect(screen.getByText(/This server remains paused/)).toBeTruthy();
    expect(calls.find(call => call.method === "PATCH")?.body.state).toBeUndefined();
  });
});

describe("managed Discord sign-in continuation", () => {
  it("resumes adding Camel after sign-in, and keeps ordinary login links unchanged", () => {
    expect(discordInstallNext("/console/channels", "?discord_install=1")).toBe("/console/discord/install");
    expect(discordInstallNext("/console/channels", `?discord_install=1&guild_id=${guildId}&next=https://evil.example`)).toBe(`/console/discord/install?guild_id=${guildId}`);
    expect(discordInstallNext("/console/channels", "?discord_install=1&guild_id=https://evil.example")).toBe("/console/discord/install");
    expect(discordInstallNext("/console/channels", "")).toBeUndefined();
    expect(discordInstallNext("/other", "?discord_install=1")).toBeUndefined();
    expect(consoleLoginUrl("github", "/console/discord/install")).toBe(`/console/auth/github?next=${encodeURIComponent("/console/discord/install")}`);
    expect(consoleLoginUrl("google")).toBe("/console/auth/google");
  });
});
