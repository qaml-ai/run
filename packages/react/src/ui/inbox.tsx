"use client";
import { useState, type ReactNode } from "react";
import type { InboxItem, InboxOptions, InboxPage, InputAnswer } from "@camelai/run";
export interface InboxListProps {
  /** Supply server-authorized data. Never put a tenant API key in the browser. */
  page: InboxPage;
  load: (options: InboxOptions) => Promise<InboxPage>;
  answer: (item: InboxItem, answer: InputAnswer) => Promise<unknown>;
  filters?: InboxOptions;
  renderItem: (item: InboxItem, answer: (value: InputAnswer) => Promise<void>) => ReactNode;
}
/** Preserves server priority/cursor order. load and answer can call authenticated app routes. */
export function InboxList({ page, load, answer, filters = {}, renderItem }: InboxListProps) {
  const [extra, setExtra] = useState<InboxItem[]>([]), [cursor, setCursor] = useState(page.cursor);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const key = (item: InboxItem) => JSON.stringify([item.agent, item.id]);
  const items = [...new Map([...page.items, ...extra].map(item => [key(item), item])).values()];
  async function respond(item: InboxItem, value: InputAnswer) {
    try { await answer(item, value); setAnswered(previous => new Set([...previous, key(item)])); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not answer"); throw e; }
  }
  async function more() {
    if (!cursor || busy) return;
    setBusy(true); setError(undefined);
    try { const next = await load({ ...filters, cursor }); setExtra(previous => [...previous, ...next.items]); setCursor(next.cursor); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load inbox"); }
    finally { setBusy(false); }
  }
  return <section aria-label="Inbox" aria-busy={busy}>
    {error && <p role="alert">{error}</p>}
    <ul>{items.filter(item => !answered.has(key(item))).map(item => <li key={key(item)}>{renderItem(item, value => respond(item, value))}</li>)}</ul>
    {cursor && <button type="button" disabled={busy} onClick={more}>Load more</button>}
  </section>;
}
