import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
// The layout's dithered art draws on a canvas, which jsdom lacks.
vi.mock("../web/components/auth-layout", () => ({ AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
import { SignIn } from "../web/pages/sign-in";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let methods: Record<string, unknown>;
beforeEach(() => {
  methods = { github: true, google: true, password: true, open: true };
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/console/auth/methods" ? json(methods) : json({ sent: true }, 202)));
  history.replaceState(null, "", "/console/");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the sign-in page", () => {
  it("offers no sign-up or reset where the runtime has no account mail", async () => {
    render(<SignIn onSignedIn={() => {}} />);
    expect(await screen.findByRole("button", { name: "Sign in with email" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign up with email" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).toBeNull();
  });

  it("stays the sign-in page at /console/signup when sign-up is not offered", async () => {
    history.replaceState(null, "", "/console/signup");
    render(<SignIn onSignedIn={() => {}} />);
    expect(await screen.findByRole("button", { name: "Sign in with email" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  it("switches to signing up and back, at its own address", async () => {
    methods = { ...methods, signup: true, reset: true };
    render(<SignIn onSignedIn={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign up with email" }));
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(screen.getByText("Create your camelRun account")).toBeTruthy();
    expect(location.pathname).toBe("/console/signup");
    // GitHub and Google sign up too.
    expect(screen.getByText("Continue with GitHub")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in with email" })).toBeTruthy();
    expect(location.pathname).toBe("/console/");
  });

  it("opens the reset form from Forgot password, or at /console/reset, and passes on where to go after", async () => {
    methods = { ...methods, reset: true };
    history.replaceState(null, "", "/console/reset?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx");
    render(<SignIn onSignedIn={() => {}} />);
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(screen.queryByText("Continue with GitHub")).toBeNull();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "kay@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/console/auth/reset/request")).toBe(true));
    const [, init] = vi.mocked(fetch).mock.calls.find(([path]) => path === "/console/auth/reset/request")!;
    expect(JSON.parse(init!.body as string)).toEqual({ email: "kay@example.com", next: "/oauth/authorize?client_id=x" });
  });
});
