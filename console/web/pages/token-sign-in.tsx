import { useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { api } from "@/lib/api";

/** Signing in with an operator or API token; `next` resumes adding Camel to Discord. */
export function TokenForm({ onSignedIn, next }: { onSignedIn: () => void; next?: string }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const signedIn = await api<{ next?: string }>("/console/auth/token", { body: { token: token.trim(), ...(next ? { next } : {}) } });
      // The server accepted only its own install route: that is a page load (on to Discord), not a console route.
      if (signedIn.next && signedIn.next === next) { location.assign(signedIn.next); return; }
      history.replaceState(null, "", "/console/");
      dispatchEvent(new PopStateEvent("popstate"));
      onSignedIn();
    }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="token">Operator or API token</Label>
        <Input id="token" type="password" autoComplete="off" placeholder="art_…" value={token} onChange={event => setToken(event.target.value)} />
      </div>
      <PixelButton size="hero" type="submit" className="w-full" loading={busy} disabled={!token.trim() || busy}>
        Sign in with token
      </PixelButton>
    </form>
  );
}

/**
 * The unlisted /console/sign-in/token page: nothing links to it. A session it makes has none of the console's own
 * powers (minting API tokens, billing, Get Help, deleting the account). TODO: remove after the ChatGPT review (docs/operations).
 */
export function TokenSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">camelRun</h1>
          <p className="text-muted-foreground text-sm text-balance">Sign in with an API token.</p>
        </div>
        <TokenForm onSignedIn={onSignedIn} />
      </div>
    </AuthLayout>
  );
}
