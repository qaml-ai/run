import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetHelp } from "../web/components/get-help";
import { api, ApiError } from "../web/lib/api";
import { helpContext, setHelpTenant } from "../web/lib/help-context";
import type { HelpSubmission } from "../../shared/help-contract.ts";

const json = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
let bodies: HelpSubmission[];
let enabled: boolean;
let replyEmails: string[];
let send: (body: HelpSubmission) => Response | Promise<Response>;
beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/console/agents/client_example?token=private#secret");
  setHelpTenant(undefined); setHelpTenant("alice");
  enabled = true; bodies = []; replyEmails = [];
  send = () => json({ success: true, reference: "R-12345678" });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/v1/help" && !init?.body) return json({ enabled, replyEmails });
    if (path === "/v1/help") {
      const body = JSON.parse(init!.body as string); bodies.push(body); return send(body);
    }
    return json({ error: "private response body", code: "TEST_ERROR" }, 502);
  }));
  // Radix uses these browser APIs when its select opens; jsdom supplies neither.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setHelpTenant(undefined); });

async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Get help" }));
  return screen.findByRole("dialog");
}
function fill() {
  fireEvent.change(screen.getByLabelText("Your email"), { target: { value: "person@example.test" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "My agent fails when I send a prompt." } });
}
describe("Get help", () => {
  it("hides the button when support isn't configured", async () => {
    enabled = false;
    const { container } = render(<GetHelp tenant="alice" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("uses the verified email on file without allowing a new typed address", async () => {
    replyEmails = ["verified@example.test"];
    localStorage.setItem("camelrun:help-email:alice", "unverified@example.test");
    render(<GetHelp tenant="alice" />);
    await open();
    const email = screen.getByLabelText("Your email") as HTMLInputElement;
    expect(email.value).toBe("verified@example.test");
    expect(email.readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Help with my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies[0].email).toBe("verified@example.test");
  });

  it("offers only existing verified addresses when there are several", async () => {
    replyEmails = ["one@example.test", "two@example.test"];
    render(<GetHelp tenant="alice" />);
    await open();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Your email" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "two@example.test" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Help with my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies[0].email).toBe("two@example.test");
  });

  it("switches to the remaining saved address when the first is suppressed", async () => {
    replyEmails = ["owner@example.test", "ops@example.test"];
    send = () => {
      replyEmails = ["ops@example.test"];
      return json({ error: "Use another email address.", code: "HELP_RECIPIENT_SUPPRESSED" }, 422);
    };
    render(<GetHelp tenant="alice" />);
    await open();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Help with my account" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("alert");
    await waitFor(() => expect((screen.getByLabelText("Your email") as HTMLInputElement).value).toBe("ops@example.test"));
    expect((screen.getByLabelText("Your email") as HTMLInputElement).readOnly).toBe(true);
    send = () => json({ success: true, reference: "R-12345678" });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies.map(body => body.email)).toEqual(["owner@example.test", "ops@example.test"]);
    expect(bodies[1].submissionId).not.toBe(bodies[0].submissionId);
  });

  it("prefills the agent, keeps a closed draft, and submits bounded context once", async () => {
    await expect(api("/v1/agents/secret-id/prompt?token=secret", { body: { secret: "not shared" } })).rejects.toBeInstanceOf(ApiError);
    render(<GetHelp tenant="alice" agentId="client_example" />);
    await open(); fill();
    expect((screen.getByLabelText(/Agent ID/) as HTMLInputElement).value).toBe("client_example");
    fireEvent.click(screen.getByLabelText("Blocking"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await open();
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toMatch(/My agent/);
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ email: "person@example.test", impact: "blocking", agentId: "client_example", context: {
      page: "/console/agents/client_example", failures: [{ method: "POST", path: "/v1/agents/:id/prompt", status: 502 }],
    } });
    expect(JSON.stringify(bodies[0])).not.toMatch(/private|secret|token=/);
    expect(screen.getByRole("status").textContent).toContain("person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await open();
    expect((screen.getByLabelText("Your email") as HTMLInputElement).value).toBe("person@example.test");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
  });

  it("hides impact for a question and omits it from the submission", async () => {
    render(<GetHelp tenant="alice" />);
    await open(); fill();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Category" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "How-to question" }));
    expect(screen.queryByText("Impact")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies[0].category).toBe("question");
    expect(bodies[0].impact).toBeUndefined();
  });

  it("keeps the exact payload for partial-send retries, including after closing", async () => {
    send = () => json({ error: "One email could not be sent.", code: "HELP_DELIVERY_FAILED" }, 503, { "Retry-After": "5" });
    render(<GetHelp tenant="alice" />);
    await open(); fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await open();
    // Move past the deadline; reopening preserved the failed submission and its UUID.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5100)); });
    send = () => json({ success: true, reference: "R-12345678" });
    fireEvent.click(await screen.findByRole("button", { name: "Retry request" }));
    await screen.findByText("Help request sent");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  }, 10_000);

  it("allows a corrected address with a new ID after suppression", async () => {
    send = () => json({ error: "Use another email address.", code: "HELP_RECIPIENT_SUPPRESSED" }, 422, { "Retry-After": "0.01" });
    render(<GetHelp tenant="alice" />);
    await open(); fill();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Your email") as HTMLInputElement).closest("fieldset")?.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Your email"), { target: { value: "corrected@example.test" } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    send = () => json({ success: true, reference: "R-12345678" });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByText("Help request sent");
    expect(bodies[1].email).toBe("corrected@example.test");
    expect(bodies[1].submissionId).not.toBe(bodies[0].submissionId);
  });

  it("blocks closing and double sends while awaiting the backend", async () => {
    const pending = Promise.withResolvers<Response>();
    send = () => pending.promise;
    render(<GetHelp tenant="alice" />);
    await open(); fill();
    const button = screen.getByRole("button", { name: "Send request" });
    fireEvent.click(button); fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(bodies).toHaveLength(1);
    await act(async () => { pending.resolve(json({ success: true, reference: "R-12345678" })); });
    await screen.findByText("Help request sent");
  });
});

describe("automatic diagnostics", () => {
  it("keeps only five route templates and excludes auth, help and unknown URLs", async () => {
    for (let index = 0; index < 7; index++) await api(`/v1/agents/secret-${index}?token=secret`).catch(() => {});
    await api("/console/auth/token", { body: { token: "private" } }).catch(() => {});
    await api("/v1/links/secret").catch(() => {});
    const snapshot = helpContext()!;
    expect(snapshot.failures).toHaveLength(5);
    expect(snapshot.failures?.every(failure => failure.path === "/v1/agents/:id")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|token=/);
  });

  it("doesn't attribute a prior tenant's late response to the new tenant", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", () => pending.promise);
    const request = api("/v1/agents").catch(() => {});
    setHelpTenant("bob");
    pending.resolve(json({ error: "failed" }, 500));
    await request;
    expect(helpContext()?.failures).toEqual([]);
  });

  it("captures network failures without recording their error message", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("secret upstream URL")));
    await api("/v1/agents", { body: { key: "secret-key" } }).catch(() => {});
    expect(helpContext()?.failures?.[0]).toMatchObject({ method: "POST", path: "/v1/agents", status: 0 });
    expect(JSON.stringify(helpContext())).not.toContain("secret");
  });
});
