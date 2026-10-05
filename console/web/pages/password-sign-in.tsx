import { useState, type FormEvent, type ReactNode } from "react";
import { ErrorAlert } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { api } from "@/lib/api";

/** The shortest password the runtime takes. */
export const MIN_PASSWORD = 12;

/** After signing in: on to `next` where the server accepted it (a page load: Discord, or an app's consent page), else the console. */
export function signedIn(accepted: string | undefined, onSignedIn: () => void) {
  if (accepted) { location.assign(accepted); return; }
  history.replaceState(null, "", "/console/");
  dispatchEvent(new PopStateEvent("popstate"));
  onSignedIn();
}

/**
 * Signing in with an email address and password. `next` resumes adding Camel to Discord or connecting an app;
 * `secondary` when GitHub or Google is offered above it; `onForgot` where a reset link can be mailed.
 */
export function PasswordForm({ onSignedIn, next, secondary = false, onForgot }: { onSignedIn: () => void; next?: string; secondary?: boolean; onForgot?: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await api<{ next?: string }>("/console/auth/password", { body: { email: email.trim(), password, ...(next ? { next } : {}) } });
      // The server accepted only its own routes: those are page loads (on to Discord, or the consent page), not console routes.
      signedIn(result.next && result.next === next ? result.next : undefined, onSignedIn);
    }
    catch (caught) { setError((caught as Error).message); setPassword(""); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="password">Password</Label>
          {onForgot && <button type="button" className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline" onClick={onForgot}>Forgot password?</button>}
        </div>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
      </div>
      <PixelButton size="hero" type="submit" variant={secondary ? "secondary" : undefined} className="w-full" loading={busy} disabled={!email.trim() || !password || busy}>
        Sign in with email
      </PixelButton>
    </form>
  );
}

/** "Check your email", the same whether or not the address has an account. */
function Sent({ email, children }: { email: string; children?: ReactNode }) {
  return (
    <div role="status" className="grid gap-3 text-sm">
      <p className="font-medium">Check your email</p>
      <p className="text-muted-foreground">If <span className="text-foreground break-all">{email}</span> can use it, we sent it a link. {children}</p>
    </div>
  );
}

/**
 * Signing up with an email address and a password of at least MIN_PASSWORD characters. The server mails a link that
 * finishes it (with this password), and answers the same whether or not the address has an account. "Send again" asks
 * once more with the same address and password.
 */
export function SignUpForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/console/auth/signup", { body: { email: email.trim(), password, ...(next ? { next } : {}) } });
      setSent(email.trim());
    }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  if (sent) return (
    <div className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Not sent" className="mb-0" />
      <Sent email={sent}>Open it and enter the password you chose to finish. It expires in 24 hours.</Sent>
      <PixelButton size="hero" variant="secondary" className="w-full" loading={busy} disabled={busy} onClick={() => void submit()}>Send again</PixelButton>
    </div>
  );
  return (
    <form onSubmit={submit} className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Sign-up failed" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="signup-email">Email</Label>
        <Input id="signup-email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="signup-password">Password</Label>
        <Input id="signup-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} />
        <p className="text-muted-foreground text-xs">At least {MIN_PASSWORD} characters.</p>
      </div>
      <PixelButton size="hero" type="submit" className="w-full" loading={busy} disabled={!email.trim() || password.length < MIN_PASSWORD || busy}>
        Create account
      </PixelButton>
    </form>
  );
}

/** Asking for a password reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try { await api("/console/auth/reset/request", { body: { email: email.trim(), ...(next ? { next } : {}) } }); setSent(email.trim()); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  if (sent) return <Sent email={sent}>It expires in an hour.</Sent>;
  return (
    <form onSubmit={submit} className="grid gap-4">
      <p className="text-muted-foreground text-sm">Enter the address you sign in with, and we'll email you a link to choose a new password.</p>
      <ErrorAlert error={error || undefined} title="Not sent" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="reset-email">Email</Label>
        <Input id="reset-email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} />
      </div>
      <PixelButton size="hero" type="submit" className="w-full" loading={busy} disabled={!email.trim() || busy}>Email me a link</PixelButton>
    </form>
  );
}
