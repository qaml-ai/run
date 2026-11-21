import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("../web/components/auth-layout", () => ({
  AuthLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { SignIn } from "../web/pages/sign-in";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  history.replaceState(null, "", "/console/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("v2 console sign-in (GitHub, Google, Email/Password)", () => {
  it("renders GitHub, Google, and email/password sign-in without an API key input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ github: true, google: true, password: true, signup: true, open: true })),
    );

    render(<SignIn onSignedIn={() => {}} />);

    const gh = await screen.findByRole("link", { name: /Continue with GitHub/ });
    const google = screen.getByRole("link", { name: /Continue with Google/ });
    expect(gh.getAttribute("href")).toBe("/console/auth/github");
    expect(google.getAttribute("href")).toBe("/console/auth/google");
    expect(screen.getByRole("button", { name: "Sign in with email" })).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it("signs in with email and password via POST /console/auth/password", async () => {
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === "/console/auth/methods") return json({ github: true, google: true, password: true, signup: true });
      if (path === "/console/auth/password") return json({ ok: true, tenant: "tnt_1" });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();

    render(<SignIn onSignedIn={onSignedIn} />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([p]) => p === "/console/auth/password");
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).headers).toMatchObject({ "X-Agent-Runtime-Console": "1" });
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      email: "ada@example.com",
      password: "correct-horse-battery",
    });
  });

  it("switches to sign-up at /console/signup and creates an account via POST /console/auth/signup", async () => {
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === "/console/auth/methods") return json({ github: true, google: true, password: true, signup: true });
      if (path === "/console/auth/signup") return json({ ok: true, tenant: "tnt_new" }, 201);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();

    render(<SignIn onSignedIn={onSignedIn} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign up with email" }));
    expect(location.pathname).toBe("/console/signup");
    expect(screen.getByText("Create your camelRun account")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "supersecret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([p]) => p === "/console/auth/signup");
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      email: "ada@example.com",
      password: "supersecret123",
      name: "Ada Lovelace",
    });
  });

  it("shows error message on failed email sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/console/auth/methods") return json({ github: false, google: false, password: true, signup: true });
        return json({ error: { code: "unauthorized", message: "Wrong email or password" } }, 401);
      }),
    );

    render(<SignIn onSignedIn={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrongpass" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));

    expect(await screen.findByText("Wrong email or password")).toBeTruthy();
  });
});
