import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { InboxPage } from "../web/pages/inbox";
import { answerInbox, inboxCount, type InboxItem } from "../web/lib/inbox";
const item = { id: "row", inputId: "runtime-input", agent: "agent-a", kind: "approval", message: "Allow deploy?", detail: {}, priority: "high", blocking: true, subject: "Release", state: "pending" } as InboxItem;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("answers using the runtime input id rather than the inbox row id", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await answerInbox(item, true);
  expect(fetcher.mock.calls[0][0]).toBe("/v1/agents/agent-a/inputs/runtime-input");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ action: "accept" });
});
it("shows counts, filters and cursors, and approves with the keyboard", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === "POST" ? {} : { items: [item], cursor: "next-page", counts: { priority: { urgent: 0, high: 2, normal: 0, low: 0 }, lead: { "agent-a": 2 } } }));
  vi.stubGlobal("fetch", fetcher);
  render(<InboxPage />);
  await screen.findByText("Allow deploy?");
  expect(screen.getByText(/2 unanswered/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Release" }).getAttribute("href")).toContain("input=runtime-input");
  fireEvent.keyDown(window, { key: "a" });
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => String(url).includes("/inputs/runtime-input") && init?.method === "POST")).toBe(true));
  await userEvent.selectOptions(screen.getByLabelText("Priority"), "high");
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("priority=high"))).toBe(true));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("cursor=next-page"))).toBe(true));
});
it("counts all priorities", () => {
  expect(inboxCount({ counts: { priority: { urgent: 1, high: 2, normal: 3, low: 4 }, lead: {} }, items: [], cursor: null })).toBe(10);
});
