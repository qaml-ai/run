import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headersFrom, TelemetryPage } from "../web/pages/telemetry";
import type { Telemetry, TelemetryTest } from "../web/lib/api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SECRET = "hcaik_super_secret_value";
let stored: Telemetry | undefined;
let testResult: TelemetryTest;
let calls: { path: string; method: string; body?: any; console?: string | null }[];

const settings = (change: Partial<Telemetry> = {}): Telemetry => ({
  endpoint: "https://api.honeycomb.io/v1/traces", protocol: "http/protobuf", sampleRate: 0.5, include: { content: false },
  headers: ["x-honeycomb-team"], createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000,
  status: { lastExportAt: null, lastError: null, lastErrorAt: null }, ...change,
});

beforeEach(() => {
  calls = []; stored = undefined;
  testResult = { ok: true, status: 200, traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method, body, console: new Headers(init?.headers).get("X-Agent-Runtime-Console") });
    if (path === "/v1/telemetry" && method === "GET") return stored ? json(stored) : json({ error: "No telemetry is set" }, 404);
    if (path === "/v1/telemetry" && method === "PUT") {
      const keep = body.headers === undefined && stored && new URL(stored.endpoint).origin === new URL(body.endpoint).origin;
      stored = settings({ endpoint: body.endpoint, protocol: body.protocol, sampleRate: body.sampleRate, include: { content: !!body.include?.content },
        headers: keep ? stored!.headers : Object.keys(body.headers ?? {}).sort(), updatedAt: Date.now() + calls.length });
      return json(stored);
    }
    if (path === "/v1/telemetry" && method === "DELETE") { stored = undefined; return json({ deleted: true }); }
    if (path === "/v1/telemetry/test") return json(testResult);
    return json({ error: "unexpected" }, 500);
  }));
  // Radix uses these browser APIs when its select opens; jsdom supplies neither.
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const writes = () => calls.filter(call => call.method !== "GET");

describe("TelemetryPage", () => {
  it("offers setup when nothing is set, with content off", async () => {
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    expect(await screen.findByRole("button", { name: "Start exporting" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send test span/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Export status" })).toBeNull();
    const content = screen.getByRole("checkbox", { name: /Include content/ }) as HTMLInputElement;
    expect(content.checked).toBe(false);
    expect(screen.getByText(/Off by default/)).toBeTruthy();
  });

  it("shows stored settings, header names masked, and the export status", async () => {
    stored = settings({ status: { lastExportAt: 1_790_000_100_000, lastError: "HTTP 401", lastErrorAt: 1_790_000_200_000 } });
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    expect(((await screen.findByLabelText("Endpoint")) as HTMLInputElement).value).toBe("https://api.honeycomb.io/v1/traces");
    expect((screen.getByLabelText("Runs traced (%)") as HTMLInputElement).value).toBe("50");
    const headers = screen.getByRole("list", { name: "Stored headers" });
    expect(headers.textContent).toContain("x-honeycomb-team");
    expect(headers.textContent).toContain("••••••••");
    const status = screen.getByRole("region", { name: "Export status" });
    expect(status.textContent).toContain("HTTP 401");
    expect(status.textContent).not.toContain("No spans exported yet");
  });

  it("saves, keeping stored headers unless they are replaced, and never shows a value", async () => {
    stored = settings();
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.change(await screen.findByLabelText("Runs traced (%)"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Include content/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "PUT", path: "/v1/telemetry", console: "1",
      body: { endpoint: "https://api.honeycomb.io/v1/traces", protocol: "http/protobuf", sampleRate: 0.25, include: { content: true } } });
    expect(writes()[0].body).not.toHaveProperty("headers");
    expect(await screen.findByRole("status")).toBeTruthy();

    // Replacing a header sends the whole set, with the new value, which is not shown afterwards.
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    const value = screen.getByLabelText("Value for x-honeycomb-team") as HTMLInputElement;
    expect(value.value).toBe("");
    expect(value.type).toBe("password");
    fireEvent.change(value, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body.headers).toEqual({ "x-honeycomb-team": SECRET });
    await screen.findByRole("list", { name: "Stored headers" });
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toBe(SECRET);
  });

  it("removes a stored header by sending the rest", async () => {
    stored = settings({ headers: ["Langsmith-Project", "x-api-key"], endpoint: "https://api.smith.langchain.com/otel/v1/traces" });
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Langsmith-Project" }));
    expect(screen.queryByLabelText("Value for Langsmith-Project")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter a value for x-api-key/)).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Value for x-api-key"), { target: { value: "lsv2_key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.headers).toEqual({ "x-api-key": "lsv2_key" });
  });

  it("fills the endpoint and header names from a preset", async () => {
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Preset" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "LangSmith" }));
    expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe("https://api.smith.langchain.com/otel/v1/traces");
    const names = screen.getAllByLabelText("Header name").map(input => (input as HTMLInputElement).value);
    expect(names).toEqual(["x-api-key", "Langsmith-Project"]);
  });

  it("sends a test span and shows the result with its trace ID", async () => {
    stored = settings();
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test span/ }));
    expect(await screen.findByText("The endpoint accepted the test span (HTTP 200)")).toBeTruthy();
    expect(screen.getByText(testResult.traceId)).toBeTruthy();
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/v1/telemetry/test" });
  });

  it("shows what the endpoint answered when the test span fails", async () => {
    stored = settings();
    testResult = { ok: false, status: 401, error: "Unauthorized", traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" };
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Send test span/ }));
    expect(await screen.findByText("The test span was not accepted")).toBeTruthy();
    expect(screen.getByText("HTTP 401: Unauthorized")).toBeTruthy();
    expect(screen.getByText(testResult.traceId)).toBeTruthy();
  });

  it("removes telemetry only after confirming", async () => {
    stored = settings();
    render(<TelemetryPage me={{ canStoreKeys: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Remove telemetry" }));
    await waitFor(() => expect(writes()).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/telemetry" })]));
    expect(await screen.findByRole("button", { name: "Start exporting" })).toBeTruthy();
  });

  it("checks header rows", () => {
    expect(headersFrom([{ name: " a ", value: "1" }, { name: "", value: "" }])).toEqual({ headers: { a: "1" } });
    expect(headersFrom([{ name: "", value: "1" }])).toHaveProperty("error");
    expect(headersFrom([{ name: "A", value: "1" }, { name: "a", value: "2" }])).toEqual({ error: "a is listed twice." });
  });
});
