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

describe("v2 console sign-in", () => {
  it("authenticates with a CamelRun v2 API key and sets session via /console/auth/key", async () => {
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === "/console/auth/methods") return json({ apiKey: true, github: false, google: false, cookieAuth: true });
      if (path === "/console/auth/key") return json({ ok: true, me: { tenantId: "tnt_1" } });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSignedIn = vi.fn();

    render(<SignIn onSignedIn={onSignedIn} />);
    const input = await screen.findByLabelText("API key");
    fireEvent.change(input, { target: { value: "cr_live_tnt_1.abc_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([p]) => p === "/console/auth/key");
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).headers).toMatchObject({ "X-Agent-Runtime-Console": "1" });
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ apiKey: "cr_live_tnt_1.abc_secret" });
  });

  it("displays v2 error messages when API key validation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/console/auth/methods") return json({ apiKey: true, github: false, google: false });
        return json({ error: { code: "unauthorized", message: "Invalid API key" } }, 401);
      }),
    );

    render(<SignIn onSignedIn={() => {}} />);
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "cr_live_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid API key")).toBeTruthy();
  });

  it("renders GitHub/Google buttons when enabled in /console/auth/methods", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ apiKey: true, github: true, google: true, cookieAuth: true })),
    );
    render(<SignIn onSignedIn={() => {}} />);
    expect(await screen.findByText("Continue with GitHub")).toBeTruthy();
    expect(screen.getByText("Continue with Google")).toBeTruthy();
  });
});
