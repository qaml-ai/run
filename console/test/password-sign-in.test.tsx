import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordForm } from "../web/pages/password-sign-in";

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

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
};

describe("email and password sign-in", () => {
  it("waits for both fields, then signs in and into the console", async () => {
    const signedIn = vi.fn();
    render(<PasswordForm onSignedIn={signedIn} />);
    const submit = screen.getByRole("button", { name: "Sign in with email" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fill(" reviewer@example.com ", "");
    expect(submit.disabled).toBe(true);
    fill(" reviewer@example.com ", "correct horse battery");
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(signedIn).toHaveBeenCalled());
    expect(calls).toEqual([{ path: "/console/auth/password", method: "POST", body: { email: "reviewer@example.com", password: "correct horse battery" }, console: "1" }]);
    expect(location.pathname).toBe("/console/");
  });

  it("passes a Discord install to resume, and goes there", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...location, assign });
    reply = () => json({ tenant: "chatgpt-review", next: "/console/discord/install" });
    render(<PasswordForm onSignedIn={() => {}} next="/console/discord/install" />);
    fill("reviewer@example.com", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/console/discord/install"));
    expect((calls[0].body as { next?: string }).next).toBe("/console/discord/install");
  });

  it("says why a sign-in failed, and clears the password", async () => {
    reply = () => json({ error: "Wrong email or password" }, 401);
    const signedIn = vi.fn();
    render(<PasswordForm onSignedIn={signedIn} />);
    fill("reviewer@example.com", "not the password");
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));
    expect(await screen.findByText("Wrong email or password")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("reviewer@example.com");
    expect(signedIn).not.toHaveBeenCalled();
  });

  it("offers the address and password fields to password managers", () => {
    render(<PasswordForm onSignedIn={() => {}} />);
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
  });
});
