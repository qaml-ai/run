import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, CircleHelp, Loader2 } from "lucide-react";
import { HELP_CATEGORIES, HELP_CATEGORY_LABELS, HELP_IMPACTS, HELP_IMPACT_DESCRIPTIONS, HELP_IMPACT_LABELS,
  HELP_LIMITS, type HelpAvailability, type HelpCategory, type HelpImpact, type HelpResponse, type HelpSubmission } from "../../../shared/help-contract.ts";
import { api, ApiError, useApi } from "@/lib/api";
import { helpContext, lastHelpEmail, rememberHelpEmail } from "@/lib/help-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** One instance in the navigation works on desktop and mobile, and preserves a draft when closed. */
export function GetHelp({ tenant, agentId }: { tenant: string; agentId?: string }) {
  const available = useApi<HelpAvailability>("/v1/help");
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [initialAgent, setInitialAgent] = useState(agentId ?? "");
  const [completed, setCompleted] = useState(false);
  const [started, setStarted] = useState(false);
  const busy = useRef(false);
  const changeOpen = (next: boolean) => {
    if (busy.current) return;
    if (next) void available.reload();
    if (next && (!started || completed)) {
      setInitialAgent(agentId ?? "");
      setSession(value => value + 1);
      setCompleted(false);
      setStarted(true);
    }
    setOpen(next);
  };
  if (!available.data?.enabled) return null;
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild>
      <button type="button" className="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-muted-foreground focus-visible:ring-ring flex shrink-0 items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors outline-none focus-visible:ring-2">
        <CircleHelp aria-hidden="true" className="size-4" />Get help
      </button>
    </DialogTrigger>
    <HelpForm key={session} tenant={tenant} initialAgent={initialAgent} replyEmails={available.data.replyEmails ?? []} onBusy={value => { busy.current = value; }}
      onRefreshEmails={available.reload} onComplete={() => setCompleted(true)} onClose={() => changeOpen(false)} />
  </Dialog>;
}

function HelpForm({ tenant, initialAgent, replyEmails, onBusy, onRefreshEmails, onComplete, onClose }: {
  tenant: string; initialAgent: string; replyEmails: string[]; onBusy: (busy: boolean) => void; onComplete: () => void; onClose: () => void;
  onRefreshEmails: () => Promise<void>;
}) {
  const id = useId();
  const [email, setEmail] = useState(() => {
    const saved = lastHelpEmail(tenant);
    return replyEmails.length ? replyEmails.find(value => value.toLowerCase() === saved.toLowerCase()) ?? replyEmails[0] : saved;
  });
  const [category, setCategory] = useState<HelpCategory>("bug");
  const [impact, setImpact] = useState<HelpImpact>("minor");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(initialAgent);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  // A failed or ambiguous send must reuse the exact payload, including context and UUID.
  const [attempt, setAttempt] = useState<HelpSubmission>();
  const [error, setError] = useState("");
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [sent, setSent] = useState<HelpResponse>();
  useEffect(() => {
    if (!attempt && replyEmails.length && !replyEmails.some(value => value.toLowerCase() === email.toLowerCase())) setEmail(replyEmails[0]);
  }, [replyEmails, email, attempt]);
  const successFocus = useRef<HTMLDivElement>(null);
  const errorFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!waitUntil) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= waitUntil) setWaitUntil(0);
    }, 1000);
    return () => clearInterval(timer);
  }, [waitUntil]);
  useEffect(() => { if (sent) successFocus.current?.focus(); }, [sent]);
  useEffect(() => { if (error) errorFocus.current?.focus(); }, [error]);
  const seconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const locked = busy || !!attempt;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || seconds || !description.trim()) return;
    const payload = attempt ?? {
      submissionId: crypto.randomUUID(), email: email.trim(), category,
      ...(category === "bug" ? { impact } : {}), description: description.trim(),
      ...(agentId.trim() ? { agentId: agentId.trim() } : {}), ...(requestId.trim() ? { requestId: requestId.trim() } : {}), context: helpContext(),
    };
    sending.current = true;
    setBusy(true); onBusy(true); setAttempt(payload); setError("");
    try {
      const response = await api<HelpResponse>("/v1/help", { body: payload });
      if (response?.success !== true || typeof response.reference !== "string") throw new Error("Incomplete response");
      rememberHelpEmail(tenant, payload.email);
      setSent(response); onComplete();
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : undefined;
      setError(failure?.message ?? "We couldn't confirm your request was sent. Retry to check it without starting a new request.");
      // These responses explicitly mean the content needs correction (or no send was reserved).
      const correctable = failure && (failure.status === 400 || failure.status === 403 || failure.status === 404 || failure.status === 429 ||
        failure.code === "HELP_RECIPIENT_SUPPRESSED" || failure.code === "HELP_PAYLOAD_MISMATCH");
      if (correctable) {
        setAttempt(undefined);
        if (failure.status === 400 || failure.code === "HELP_RECIPIENT_SUPPRESSED") await onRefreshEmails();
      }
      const delay = failure?.retryAfter ?? (failure?.status === 429 ? 60 : correctable ? 0 : 5);
      setNow(Date.now()); setWaitUntil(delay ? Date.now() + delay * 1000 : 0);
    } finally {
      sending.current = false; setBusy(false); onBusy(false);
    }
  }

  const content = sent ? <>
    <DialogHeader>
      <DialogTitle>Help request sent</DialogTitle>
      <DialogDescription>Our support team will reply by email.</DialogDescription>
    </DialogHeader>
    <div ref={successFocus} tabIndex={-1} className="space-y-3 outline-none" role="status">
      <Check aria-hidden="true" className="text-chart-1 size-6" />
      <p className="text-sm">We sent a copy to <strong className="break-all">{attempt?.email ?? email}</strong>. Reply to that email to add details, screenshots or logs.</p>
      <p className="text-muted-foreground text-xs">Reference <span className="text-foreground font-mono">{sent.reference}</span></p>
    </div>
    <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
  </> : <>
    <DialogHeader>
      <DialogTitle>Get help</DialogTitle>
      <DialogDescription>Tell us what's happening with camelRun. We'll follow up by email.</DialogDescription>
    </DialogHeader>
    <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
      <fieldset disabled={locked} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-email`}>Your email</Label>
          {replyEmails.length > 1 ? <Select value={email} disabled={locked} onValueChange={setEmail}>
            <SelectTrigger id={`${id}-email`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{replyEmails.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
          </Select> : <Input id={`${id}-email`} type="email" autoComplete="email" required maxLength={HELP_LIMITS.email} value={email}
            readOnly={replyEmails.length === 1} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" aria-describedby={replyEmails.length ? `${id}-email-detail` : undefined} />}
          {replyEmails.length > 0 && <p id={`${id}-email-detail`} className="text-muted-foreground text-xs">{replyEmails.length === 1 ? "Using your verified email on file." : "Choose a verified email already on file."}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-category`}>Category</Label>
          <Select value={category} disabled={locked} onValueChange={value => setCategory(value as HelpCategory)}>
            <SelectTrigger id={`${id}-category`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{HELP_CATEGORIES.map(value => <SelectItem key={value} value={value}>{HELP_CATEGORY_LABELS[value]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {category === "bug" && <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium">Impact</legend>
          <div className="grid grid-cols-3 gap-2">
            {HELP_IMPACTS.map(value => <label key={value} className="cursor-pointer">
              <input className="peer sr-only" type="radio" name={`${id}-impact`} value={value} checked={impact === value} onChange={() => setImpact(value)} aria-describedby={`${id}-impact-detail`} />
              <span className="border-input peer-checked:border-foreground peer-checked:bg-accent peer-focus-visible:ring-ring block border px-2 py-2 text-center text-xs peer-focus-visible:ring-2 peer-disabled:cursor-default peer-disabled:opacity-50">{HELP_IMPACT_LABELS[value]}</span>
            </label>)}
          </div>
          <p id={`${id}-impact-detail`} className="text-muted-foreground text-xs">{HELP_IMPACT_DESCRIPTIONS[impact]}</p>
        </fieldset>}
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-description`}>Description</Label>
          <Textarea id={`${id}-description`} required maxLength={HELP_LIMITS.description} value={description} onChange={event => setDescription(event.target.value)}
            className="min-h-28 field-sizing-fixed" rows={5} aria-describedby={`${id}-description-detail`}
            placeholder="What happened, and what did you expect? Include the SDK or API call, the error message, and roughly when it happened." />
          <div id={`${id}-description-detail`} className="text-muted-foreground flex justify-between gap-3 text-xs"><span>Please leave out API keys and passwords.</span><span className="shrink-0 font-mono">{description.length}/{HELP_LIMITS.description}</span></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-agent`}>Agent ID <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id={`${id}-agent`} value={agentId} onChange={event => setAgentId(event.target.value)} maxLength={HELP_LIMITS.agentId} placeholder="Agent ID or key" className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-request`}>Request ID <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id={`${id}-request`} value={requestId} onChange={event => setRequestId(event.target.value)} maxLength={HELP_LIMITS.requestId} placeholder="From the API response" className="font-mono" />
          </div>
        </div>
      </fieldset>
      <p className="text-muted-foreground text-xs">We'll attach account and agent status, this page, and recent console error codes for support to investigate.</p>
      {error && <div ref={errorFocus} tabIndex={-1} role="alert" className="text-destructive space-y-1 border border-destructive p-3 outline-none">
        <p>{error}</p>
        {attempt && <p className="text-foreground">Your details are saved here. Retry this request to finish sending it.</p>}
      </div>}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{attempt ? "Close" : "Cancel"}</Button>
        <Button type="submit" disabled={busy || seconds > 0 || !email.trim() || !description.trim()}>
          {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
          {busy ? "Sending…" : seconds ? `Try again in ${seconds}s` : attempt ? "Retry request" : "Send request"}
        </Button>
      </DialogFooter>
    </form>
  </>;
  return <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy}
    onInteractOutside={event => event.preventDefault()}>{content}</DialogContent>;
}
