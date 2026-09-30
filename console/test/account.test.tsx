import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPage, DELETE_PHRASE } from "../web/pages/account";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: unknown; console?: string | null }[];
let assigned: string[];
beforeEach(() => {
  calls = []; assigned = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined, console: new Headers(init?.headers).get("X-Agent-Runtime-Console") });
    return path === "/v1/account" ? json({ tenant: "u-4f2a9c1d7e3b6a58", state: "deleting" }, 202) : json({});
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
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(["DELETE /v1/account", "POST /console/auth/logout"]);
    expect(calls[0].body).toEqual({ confirm: "u-4f2a9c1d7e3b6a58" });
    expect(calls[0].console).toBe("1");
  });
});
