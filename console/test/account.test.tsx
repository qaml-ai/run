import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPage, DELETE_PHRASE, forfeited } from "../web/pages/account";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: unknown; console?: string | null }[];
let assigned: string[];
let billing: Record<string, unknown>;
let password: { email: string | null };
let change: () => Response;
beforeEach(() => {
  calls = []; assigned = [];
  billing = { billing: "prepaid", balance: 12_340_000, purchased: 10_000_000 };
  password = { email: null };
  change = () => json({ changed: true, signedOut: 1 });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined, console: new Headers(init?.headers).get("X-Agent-Runtime-Console") });
    if (path === "/v1/account/password") return init?.method === "PUT" ? change() : json(password);
    return path === "/v1/account" ? json({ tenant: "u-4f2a9c1d7e3b6a58", state: "deleting" }, 202) : path === "/v1/billing" ? json(billing) : json({});
  }));
  vi.stubGlobal("location", { ...location, assign: (url: string) => { assigned.push(url); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AccountPage", () => {
  it("downloads the export from the API", () => {
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    expect(screen.getByRole("link", { name: /Export data/ }).getAttribute("href")).toBe("/v1/account/export");
  });

  it("deletes only once the phrase is typed, naming the account, then signs out", async () => {
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete account/ }));
    const confirm = await screen.findByRole("button", { name: "Delete account" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "delete my acc" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: DELETE_PHRASE } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(assigned).toEqual(["/console/?deleted=1"]));
    const writes = calls.filter(call => call.method !== "GET");
    expect(writes.map(call => `${call.method} ${call.path}`)).toEqual(["DELETE /v1/account", "POST /console/auth/logout"]);
    expect(writes[0].body).toEqual({ confirm: "u-4f2a9c1d7e3b6a58" });
    expect(writes[0].console).toBe("1");
  });

  it("signs out everywhere, then back to sign-in", async () => {
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Sign out everywhere/ }));
    await waitFor(() => expect(assigned).toEqual(["/console/"]));
    expect(calls.filter(call => call.method !== "GET").map(call => `${call.method} ${call.path} ${call.console}`)).toEqual(["DELETE /v1/sessions 1"]);
  });

  it("offers no password change to an account without a password", async () => {
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    await waitFor(() => expect(calls.some(call => call.path === "/v1/account/password")).toBe(true));
    expect(screen.queryByRole("button", { name: /Change password/ })).toBeNull();
  });

  it("changes the password with the current one, once the new one is long enough and confirmed", async () => {
    password = { email: "reviewer@example.com" };
    render(<AccountPage me={{ tenant: "chatgpt-review" }} />);
    const submit = await screen.findByRole("button", { name: /Change password/ }) as HTMLButtonElement;
    expect(screen.getByText("reviewer@example.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password 123" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "too short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "too short" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new password" } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("The new passwords differ.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a much longer new password" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText("Password changed.")).toBeTruthy();
    const writes = calls.filter(call => call.method !== "GET");
    expect(writes).toEqual([{ path: "/v1/account/password", method: "PUT", body: { currentPassword: "old password 123", newPassword: "a much longer new password" }, console: "1" }]);
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("says why a password change was refused", async () => {
    password = { email: "reviewer@example.com" };
    change = () => json({ error: "The current password is wrong" }, 403);
    render(<AccountPage me={{ tenant: "chatgpt-review" }} />);
    const submit = await screen.findByRole("button", { name: /Change password/ });
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "wrong password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a much longer new password" } });
    fireEvent.click(submit);
    expect(await screen.findByText("The current password is wrong")).toBeTruthy();
    expect(screen.queryByText("Password changed.")).toBeNull();
  });

  it("shows the purchased and free credit the deletion forfeits, and where to ask", async () => {
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete account/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("Purchased credit: $10.00"));
    expect(dialog.textContent).toContain("Free credit: $2.34");
    expect(dialog.textContent).toContain("forfeited");
    expect(screen.getByRole("link", { name: "support@camelai.com" }).getAttribute("href")).toBe("mailto:support@camelai.com");
  });

  it("says so when there is no credit to forfeit", async () => {
    billing = { billing: "prepaid", balance: -50_000, purchased: 20_000_000 };
    render(<AccountPage me={{ tenant: "u-4f2a9c1d7e3b6a58" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Delete account/ }));
    expect(await screen.findByText("You have no remaining credit to forfeit.")).toBeTruthy();
  });

  it("counts free credit as spent first", () => {
    expect(forfeited({ balance: 3_000_000, purchased: 10_000_000 })).toEqual({ purchased: 3_000_000, free: 0 });
    expect(forfeited({ balance: 5_000_000, purchased: 0 })).toEqual({ purchased: 0, free: 5_000_000 });
  });
});
