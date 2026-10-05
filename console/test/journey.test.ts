import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportPages } from "@/lib/journey";
import { navigate } from "@/lib/router";

const sent = () => vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url, init: init as RequestInit, event: JSON.parse((init as RequestInit).body as string).events[0] }));

describe("reporting the console's pages", () => {
  let stop = () => {};
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    history.replaceState(null, "", "/console/");
  });
  afterEach(() => { stop(); document.head.innerHTML = ""; vi.unstubAllGlobals(); });

  it("does nothing on a runtime that has not turned journey events on", () => {
    stop = reportPages();
    navigate("tokens");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the first page and each one the console goes to, once each, to this runtime only", async () => {
    document.head.innerHTML = '<meta name="agent-runtime-journey" content="1">';
    stop = reportPages();
    navigate("agents/client_abc");
    navigate("agents/client_abc");
    navigate("tokens");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const calls = sent();
    expect(calls.map(call => call.event.page_path)).toEqual(["/console/", "/console/agents/client_abc", "/console/tokens"]);
    expect(new Set(calls.map(call => call.event.event_id)).size).toBe(3);
    for (const { url, init, event } of calls) {
      expect(url).toBe("/api/journey/events");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["X-Agent-Runtime-Console"]).toBe("1");
      expect(Object.keys(event).sort()).toEqual(["event_id", "name", "occurred_at", "page_path", "referrer_host"]);
      expect(event.name).toBe("page_viewed");
    }
  });

  it("asks once more when the runtime faults, with the same event id, and not when it answers", async () => {
    document.head.innerHTML = '<meta name="agent-runtime-journey" content="1">';
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    stop = reportPages();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [first, second] = sent();
    expect(second!.event.event_id).toBe(first!.event.event_id);
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 403 }));
    navigate("usage");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
