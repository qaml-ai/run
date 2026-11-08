import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useEffect, useRef, useState } from "react";
import { AgentInputView } from "../../../packages/registry/src/agent-chat/agent-parts";
import type { InputAnswer, InputValue } from "@camelai/run/chat";
import { Button } from "@/components/ui/button";
import { ErrorAlert, PageHeader } from "@/components/common";
import { useApi } from "@/lib/api";
import { answerInbox, inboxCount, type InboxItem, type InboxPage as Page } from "@/lib/inbox";
import { Link, navigate } from "@/lib/router";

export const inputLink = (item: InboxItem) => `agents/${encodeURIComponent(item.agent)}?input=${encodeURIComponent(item.inputId)}`;
export function InboxPage() {
  const [shortcuts, setShortcuts] = useState(false);
  const [priority, setPriority] = useState("");
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState(0);
  const query = new URLSearchParams({ limit: "30", ...(priority ? { priority } : {}), ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
  const page = useApi<Page>(`/v1/inbox?${query}`, 15_000);
  const items = page.data?.items ?? [];
  const cards = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => { const changed = () => { void page.reload(); }; window.addEventListener("inbox-changed", changed); return () => window.removeEventListener("inbox-changed", changed); }, [page.reload]);
  useEffect(() => { setSelected(0); }, [cursor, priority, kind]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && (event.target.matches("input,textarea,select") || event.target.closest('[role="dialog"]') || event.target.isContentEditable))) return;
      if (event.key === "?") { event.preventDefault(); setShortcuts(true); return; }
      if (shortcuts) return;
      const item = items[selected];
      if (!item) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault(); const next = Math.max(0, Math.min(items.length - 1, selected + (event.key === "j" ? 1 : -1))); setSelected(next); cards.current[next]?.focus();
      } else if (event.key === "Enter" && !(event.target instanceof HTMLElement && event.target.closest("button,a"))) { event.preventDefault(); navigate(inputLink(item)); }
      else if (/^[1-4]$/.test(event.key)) { event.preventDefault(); const radio = cards.current[selected]?.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]')[Number(event.key) - 1]; radio?.click();
        const questions = item.detail.questions as { multiSelect?: boolean }[] | undefined;
        if (radio && questions?.length === 1 && !questions[0].multiSelect) setTimeout(() => radio.form?.requestSubmit(), 0);
      }
      else if (event.key === "a" && item.kind === "approval") { event.preventDefault(); cards.current[selected]?.querySelector<HTMLButtonElement>('[data-input-action="approve"]')?.click(); }
      else if (event.key === "x") { event.preventDefault(); cards.current[selected]?.querySelector<HTMLButtonElement>('[data-dismiss]')?.click(); }
    }
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [items, selected, shortcuts]);
  return <>
    <PageHeader title="Inbox" description={`${inboxCount(page.data)} unanswered · j/k move · Enter opens chat · 1–4 select · a approve · x dismiss`} actions={<><Button variant="outline" onClick={() => setShortcuts(true)}>Shortcuts (?)</Button><Button variant="outline" onClick={() => void page.reload()}>Refresh</Button></>} />
    <Dialog open={shortcuts} onOpenChange={setShortcuts}><DialogContent><DialogHeader><DialogTitle>Inbox shortcuts</DialogTitle><DialogDescription>j / k: next / previous item. Enter: open chat. 1–4: choose an option. a: approve. x: open dismiss confirmation. ?: show shortcuts. Escape: close.</DialogDescription></DialogHeader></DialogContent></Dialog>
    <div className="mb-4 flex flex-wrap gap-2">
      <select aria-label="Priority" value={priority} onChange={event => { setPriority(event.target.value); setCursor(undefined); }} className="rounded border bg-background p-2"><option value="">All priorities</option>{["urgent", "high", "normal", "low"].map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Input kind" value={kind} onChange={event => { setKind(event.target.value); setCursor(undefined); }} className="rounded border bg-background p-2"><option value="">All inputs</option>{["question", "decision", "approval", "form", "url"].map(value => <option key={value}>{value}</option>)}</select>
    </div>
    <ErrorAlert error={page.error} />
    {!page.data && !page.error && <p role="status">Loading inbox…</p>}
    {page.data && !items.length && <p className="py-12 text-center text-muted-foreground">Nothing waiting on you here.</p>}
    <div className="space-y-4">{items.map((item, index) => <article tabIndex={0} ref={element => { cards.current[index] = element; }} key={item.id} onFocus={() => setSelected(index)} className={`rounded-xl border p-3 outline-none focus-visible:ring-2 ${index === selected ? "border-primary" : ""}`}>
      <div className="mb-3 flex flex-wrap justify-between gap-2 text-sm"><Link className="underline" to={inputLink(item)}>{item.subject ?? item.agent}</Link><span>{item.priority} · {item.kind}{item.blocking ? " · blocking" : ""}</span></div>
      <InboxCard item={item} onAnswered={() => void page.reload()} />
    </article>)}</div>
    <div className="mt-4 flex gap-2">{cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>Back to first</Button>}{page.data?.cursor && <Button variant="outline" onClick={() => setCursor(page.data!.cursor!)}>Next</Button>}</div>
  </>;
}
function InboxCard({ item, onAnswered }: { item: InboxItem; onAnswered: () => void }) {
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function answer(value: InputValue | InputAnswer) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await answerInbox(item, value); onAnswered(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <><AgentInputView input={{ ...item, key: item.key ?? undefined, answering: busy, ...(error ? { error: { code: "answer_failed", message: error } } : {}) }} onAnswer={value => void answer(value)} /><Button data-dismiss type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDismiss(true)}>Dismiss</Button><Dialog open={confirmDismiss} onOpenChange={setConfirmDismiss}><DialogContent><DialogHeader><DialogTitle>Dismiss this request?</DialogTitle><DialogDescription>{item.message}</DialogDescription></DialogHeader><Button disabled={busy} onClick={() => { void answer({ action: "decline" }); setConfirmDismiss(false); }}>Confirm dismiss</Button><Button variant="outline" onClick={() => setConfirmDismiss(false)}>Keep request</Button></DialogContent></Dialog></>;
}
