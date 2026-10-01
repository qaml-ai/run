import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelsPage } from "../web/pages/channels";
import { ManagedDiscord, ManagedDiscordDialog } from "../web/pages/discord-managed";
import { consoleLoginUrl, discordSetupNext } from "../web/lib/discord-setup";
import type { Channel, ManagedDiscordBinding } from "../web/lib/api";

const guildId = "123456789012345678";
const channelId = "234567890123456789";
const config = { enabled: true, applicationId: "345678901234567890", inviteUrl: "https://discord.com/oauth2/authorize?client_id=345678901234567890&scope=bot%20applications.commands" };
const channel: Channel = { id: "ch-managed", type: "discord-managed", name: "Team", definition: "definition-1", access: { public: false, allow: ["456789012345678901"] }, limits: { perSenderPerMinute: 10, turnsPerDay: 100 }, account: { id: config.applicationId, username: "Camel" }, credentials: {}, createdAt: 1 };
const binding: ManagedDiscordBinding = { guildId, guildName: "Team server", state: "active", installationState: "present", channelId: channel.id, allowedChannelIds: [channelId], channel };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: any; headers?: Headers }[];
let enabled: boolean;
let linked: boolean;
let installed: boolean;
let managedBindings: ManagedDiscordBinding[];
let listedChannels: Channel[];
let assigned: string[];
let responseBinding: ManagedDiscordBinding;
let elsewhere: "active" | "disconnected" | null;
beforeEach(() => {
  elsewhere = null;
  calls = []; enabled = true; linked = true; installed = true; managedBindings = []; listedChannels = []; assigned = [];
  responseBinding = binding;
  vi.stubGlobal("location", { ...location, pathname: "/console/channels", search: "", assign: (url: string) => assigned.push(url) });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: new Headers(init?.headers) });
    if (path === "/console/discord/config") return json({ ...config, enabled });
    if (path === "/console/discord/authorize") return json({ url: "https://discord.com/oauth2/authorize?state=verified" });
    if (path === "/console/discord/guilds") return json({ linked, guilds: linked ? [{ id: guildId, name: "Team server", installed, owned: !elsewhere, installationState: installed ? "present" : null, bindingState: elsewhere }] : [] });
    if (path === `/console/discord/guilds/${guildId}/channels`) return json({ channels: [{ id: channelId, name: "camel-test", type: 0 }] });
    if (path === "/v1/definitions") return json([{ id: "definition-1", name: "Helpful assistant", model: "model-1", revision: 1, createdAt: 1, updatedAt: 1 }]);
    if (path === "/v1/channels") return json(listedChannels);
    if (path === "/console/discord/bindings") return json(method === "GET" ? { bindings: managedBindings } : responseBinding);
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
    expect(screen.queryByRole("button", { name: "Add Camel bot" })).toBeNull();
    expect(screen.getByRole("button", { name: /New channel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText(/Bot token/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Invite Camel to your server" })).toBeTruthy();
    expect(calls.some(call => call.path === "/console/discord/bindings")).toBe(false);
  });

  it("requires explicit channel and member access before activation and uses managed API with CSRF header", async () => {
    render(<ManagedDiscordDialog config={config} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Server you manage");
    fireEvent.change(screen.getByLabelText("Server you manage"), { target: { value: guildId } });
    const checkbox = await screen.findByRole("checkbox", { name: "#camel-test" });
    const save = screen.getByRole("button", { name: "Save and activate" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Allowed member IDs"), { target: { value: "456789012345678901" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText("Team server configured");
    const write = calls.find(call => call.path === "/console/discord/bindings" && call.method === "POST")!;
    expect(write.headers?.get("X-Agent-Runtime-Console")).toBe("1");
    expect(write.body).toEqual({ guildId, definition: "definition-1", allowedChannelIds: [channelId], access: { public: false, allow: ["456789012345678901"] }, limits: { perSenderPerMinute: 10, turnsPerDay: 100 } });
    expect(screen.getByLabelText("Camel Discord test message").getAttribute("value")).toBe(`<@${config.applicationId}> status`);
    expect(screen.getByText(/Saving configuration does not verify delivery/)).toBeTruthy();
    expect(calls.some(call => call.path === "/v1/channels")).toBe(false);
  });

  it("preserves invite-first server context when linking Discord", async () => {
    linked = false;
    vi.stubGlobal("location", { ...location, pathname: "/console/channels", search: `?discord_setup=${guildId}`, assign: (url: string) => assigned.push(url) });
    render(<ChannelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Discord account" }));
    await waitFor(() => expect(assigned).toEqual(["https://discord.com/oauth2/authorize?state=verified"]));
    expect(calls.find(call => call.path === "/console/discord/authorize")?.body).toEqual({ guildId });
  });

  it("offers a server-specific install link before configuration", async () => {
    installed = false;
    render(<ManagedDiscordDialog config={config} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Server you manage"), { target: { value: guildId } });
    const invite = await screen.findByRole("link", { name: "Invite Camel to this server" });
    expect(invite.getAttribute("href")).toContain(`guild_id=${guildId}&disable_guild_select=true`);
    expect((screen.getByRole("button", { name: "Save and activate" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("routes pause through verified managed management rather than generic channel mutations", async () => {
    managedBindings = [binding];
    render(<ManagedDiscord config={config} open={false} onOpenChange={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(calls.some(call => call.method === "PATCH")).toBe(true));
    expect(calls.find(call => call.method === "PATCH")).toMatchObject({ path: `/console/discord/bindings/${guildId}`, body: { state: "paused" } });
  });

  it("uses an existing binding after OAuth continuation and can explicitly reactivate it", async () => {
    managedBindings = [{ ...binding, state: "disconnected" }];
    vi.stubGlobal("location", { ...location, search: `?discord_setup=${guildId}&discord_connected=1` });
    render(<ChannelsPage />);
    const save = await screen.findByRole("button", { name: "Save and reactivate" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText("Team server configured");
    const write = calls.find(call => call.method === "PATCH")!;
    expect(write.path).toBe(`/console/discord/bindings/${guildId}`);
    expect(write.body.state).toBe("active");
    expect(write.body.guildId).toBeUndefined();
    expect(calls.some(call => call.path === "/console/discord/bindings" && call.method === "POST")).toBe(false);
  });

  it("requires fresh Discord linking before saving an existing server", async () => {
    linked = false;
    render(<ManagedDiscordDialog config={config} binding={binding} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole("button", { name: "Connect Discord account" });
    expect((screen.getByRole("button", { name: "Save configuration" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the existing bot-token flow beside Add Camel bot", async () => {
    render(<ChannelsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect your own bot" }));
    await screen.findByText("New Discord channel");
    expect(screen.getByLabelText("Bot token")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Discord Developer Portal" })).toBeTruthy();
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
  it("preserves a validated server intent and keeps ordinary login links unchanged", () => {
    const next = discordSetupNext("/console/channels", `?discord_setup=${guildId}&next=https://evil.example`);
    expect(next).toBe(`/console/channels?discord_setup=${guildId}`);
    expect(consoleLoginUrl("github", next)).toBe(`/console/auth/github?next=${encodeURIComponent(next!)}`);
    expect(consoleLoginUrl("google")).toBe("/console/auth/google");
    expect(discordSetupNext("/console/channels", "?discord_setup=https://evil.example")).toBeUndefined();
    expect(discordSetupNext("/other", `?discord_setup=${guildId}`)).toBeUndefined();
  });

  it("lets a server's administrator disconnect it from another account, then set it up here", async () => {
    elsewhere = "active";
    render(<ManagedDiscordDialog config={{ ...config, limits: { servers: 1, turnsPerDay: 500 } }} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText("Server you manage");
    fireEvent.change(screen.getByLabelText("Server you manage"), { target: { value: guildId } });
    expect(await screen.findByText(/connected to another camelRun account/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "#camel-test" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect from the other account" }));
    elsewhere = "disconnected";
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(calls.some(call => call.path === `/console/discord/bindings/${guildId}` && call.method === "PATCH" && call.body.state === "disconnected")).toBe(true));
    expect(await screen.findByRole("checkbox", { name: "#camel-test" })).toBeTruthy();
    expect(screen.getByLabelText("Turns per server per day").getAttribute("max")).toBe("500");
  });
});
