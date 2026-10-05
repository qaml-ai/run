import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { api } from "@/lib/api";

/**
 * Signing in with an email address and password, for accounts an operator gave a password (there is no sign-up or
 * reset by email). `next` resumes adding Camel to Discord; `secondary` when GitHub or Google is offered above it.
 */
export function PasswordForm({ onSignedIn, next, secondary = false }: { onSignedIn: () => void; next?: string; secondary?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const signedIn = await api<{ next?: string }>("/console/auth/password", { body: { email: email.trim(), password, ...(next ? { next } : {}) } });
      // The server accepted only its own install route: that is a page load (on to Discord), not a console route.
      if (signedIn.next && signedIn.next === next) { location.assign(signedIn.next); return; }
      history.replaceState(null, "", "/console/");
      dispatchEvent(new PopStateEvent("popstate"));
      onSignedIn();
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
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
      </div>
      <PixelButton size="hero" type="submit" variant={secondary ? "secondary" : undefined} className="w-full" loading={busy} disabled={!email.trim() || !password || busy}>
        Sign in with email
      </PixelButton>
    </form>
  );
}
