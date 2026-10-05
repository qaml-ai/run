import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
// The layout's dithered art draws on a canvas, which jsdom lacks.
vi.mock("../web/components/auth-layout", () => ({ AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { ForgotPasswordForm, PasswordForm, SignUpForm } from "../web/pages/password-sign-in";
import { EmailLinkPage } from "../web/pages/email-link";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: { path: string; method: string; body?: any; console?: string | null }[];
let reply: (path: string, body?: any) => Response;
let assigned: string[];
beforeEach(() => {
  calls = []; assigned = [];
  reply = () => json({ sent: true }, 202);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body, console: new Headers(init?.headers).get("X-Agent-Runtime-Console") });
    return reply(path, body);
  }));
  vi.stubGlobal("location", { ...location, hash: "", assign: (url: string) => { assigned.push(url); } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("signing up with email", () => {
  it("waits for an address and a long enough password, then says to check the email, whatever the answer means", async () => {
    render(<SignUpForm next="/oauth/authorize?client_id=x" />);
    const submit = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " ada@example.com " } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "too short" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long unusual passphrase" } });
    expect(submit.disabled).toBe(false);
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
    fireEvent.click(submit);
    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(calls).toEqual([{ path: "/console/auth/signup", method: "POST", body: { email: "ada@example.com", password: "a long unusual passphrase", next: "/oauth/authorize?client_id=x" }, console: "1" }]);
    // Send again: the same address and password once more.
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual(calls[0].body);
  });

  it("says why a sign-up was refused", async () => {
    reply = () => json({ error: "That password is too common; choose another" }, 400);
    render(<SignUpForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("That password is too common; choose another")).toBeTruthy();
    expect(screen.queryByText("Check your email")).toBeNull();
  });
});

describe("forgot password", () => {
  it("is offered on the sign-in form only where a link can be mailed", () => {
    const forgot = vi.fn();
    const { unmount } = render(<PasswordForm onSignedIn={() => {}} />);
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
    unmount();
    render(<PasswordForm onSignedIn={() => {}} onForgot={forgot} />);
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(forgot).toHaveBeenCalled();
  });

  it("asks for a link and says to check the email", async () => {
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "kay@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(calls).toEqual([{ path: "/console/auth/reset/request", method: "POST", body: { email: "kay@example.com" }, console: "1" }]);
  });
});

describe("a mailed link", () => {
  it("finishes a sign-up with the chosen password, then goes on to where it started", async () => {
    vi.stubGlobal("location", { ...location, hash: `#${"t".repeat(43)}`, assign: (url: string) => { assigned.push(url); } });
    reply = path => path === "/console/auth/link" ? json({ purpose: "verify", email: "ada@example.com" }) : json({ tenant: "u-1", next: "/oauth/authorize?client_id=x" });
    render(<EmailLinkPage />);
    expect(await screen.findByText("Finish creating your account")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long unusual passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }));
    await waitFor(() => expect(assigned).toEqual(["/oauth/authorize?client_id=x"]));
    expect(calls.map(call => [call.path, call.body])).toEqual([["/console/auth/link", { token: "t".repeat(43) }], ["/console/auth/verify", { token: "t".repeat(43), password: "a long unusual passphrase" }]]);
  });

  it("sets a new password, confirmed twice, then the console", async () => {
    vi.stubGlobal("location", { ...location, hash: `#${"r".repeat(43)}`, assign: (url: string) => { assigned.push(url); } });
    reply = path => path === "/console/auth/link" ? json({ purpose: "reset", email: "kay@example.com" }) : json({ tenant: "u-1", signedOut: 2 });
    render(<EmailLinkPage />);
    expect(await screen.findByText("Choose a new password")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Set password and sign in" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a long unusual passphrase" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a long unusual passphras" } });
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("The passwords differ.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a long unusual passphrase" } });
    fireEvent.click(submit);
    await waitFor(() => expect(assigned).toEqual(["/console/"]));
    expect(calls[1]).toEqual({ path: "/console/auth/reset", method: "POST", body: { token: "r".repeat(43), password: "a long unusual passphrase" }, console: "1" });
  });

  it("says a link that no longer works is gone", async () => {
    vi.stubGlobal("location", { ...location, hash: "#expired", assign: (url: string) => { assigned.push(url); } });
    reply = () => json({ error: "This link has expired or was already used" }, 404);
    render(<EmailLinkPage />);
    expect(await screen.findByText("This link doesn't work anymore")).toBeTruthy();
  });

  it("keeps the link working after a wrong password, and says so", async () => {
    vi.stubGlobal("location", { ...location, hash: `#${"t".repeat(43)}`, assign: (url: string) => { assigned.push(url); } });
    reply = path => path === "/console/auth/link" ? json({ purpose: "verify", email: "ada@example.com" }) : json({ error: "That is not the password you chose" }, 401);
    render(<EmailLinkPage />);
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "not the one" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }));
    expect(await screen.findByText("That is not the password you chose")).toBeTruthy();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(assigned).toEqual([]);
  });
});
