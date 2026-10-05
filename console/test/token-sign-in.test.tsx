import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenForm } from "../web/pages/token-sign-in";
import { TokensPage } from "../web/pages/tokens";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: unknown; console?: string | null }[];
let reply: (path: string) => Response;
beforeEach(() => {
  calls = [];
  reply = () => json({ tenant: "chatgpt-review" });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined, console: new Headers(init?.headers).get("X-Agent-Runtime-Console") });
    return reply(path);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The form of the unlisted /console/sign-in/token page (its layout is the sign-in page's).
describe("the unlisted token sign-in page", () => {
  it("signs in with the token, then into the console", async () => {
    const signedIn = vi.fn();
    render(<TokenForm onSignedIn={signedIn} />);
    fireEvent.change(screen.getByLabelText("Operator or API token"), { target: { value: " art_review \n" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with token" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(calls).toEqual([{ path: "/console/auth/token", method: "POST", body: { token: "art_review" }, console: "1" }]);
    expect(location.pathname).toBe("/console/");
  });

  it("says why an unknown token does not sign in", async () => {
    reply = () => json({ error: "Unknown token" }, 401);
    render(<TokenForm onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText("Operator or API token"), { target: { value: "art_wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with token" }));
    expect(await screen.findByText("Unknown token")).toBeTruthy();
  });
});

describe("TokensPage for a session signed in with a token", () => {
  it("offers no new token, and says how to make one", async () => {
    reply = path => json(path === "/v1/tokens" ? [] : []);
    render(<TokensPage tenant="chatgpt-review" canMint={false} />);
    expect(await screen.findByText("Sign in with GitHub or Google to create one.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New token/ })).toBeNull();
  });
});
