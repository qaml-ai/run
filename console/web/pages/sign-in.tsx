import { useState, type FormEvent } from "react";
import { Github, KeyRound, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { Separator } from "@/components/ui/separator";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/common";
import { api, useApi } from "@/lib/api";

/** Google's "G", in the button's color: the console is monochrome. */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" />
    </svg>
  );
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const methods = useApi<{ apiKey?: boolean; github?: boolean; google?: boolean; cookieAuth?: boolean }>("/console/auth/methods");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const queryError = new URLSearchParams(location.search).get("error") ?? "";
  const providers = !!(methods.data?.github || methods.data?.google);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setBusy(true);
    setSubmitError(undefined);
    try {
      await api("/console/auth/key", { method: "POST", body: { apiKey: trimmed } });
      setApiKey("");
      onSignedIn();
    } catch (caught) {
      setSubmitError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">camelRun</h1>
          <p className="text-muted-foreground text-sm text-balance">
            Sign in with your CamelRun v2 API key to manage agents, repositories, model keys and billing.
          </p>
        </div>

        <ErrorAlert error={submitError || queryError || undefined} title="Sign-in failed" className="mb-0" />

        {providers && (
          <div className="flex flex-col gap-3">
            {methods.data?.github && (
              <PixelButton size="hero" href="/console/auth/github" className="w-full">
                <Github className="size-3.5" aria-hidden="true" />
                Continue with GitHub
              </PixelButton>
            )}
            {methods.data?.google && (
              <PixelButton size="hero" href="/console/auth/google" className="w-full">
                <GoogleMark className="size-3.5" />
                Continue with Google
              </PixelButton>
            )}
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <Separator className="flex-1" />or<Separator className="flex-1" />
            </div>
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="console-api-key">API key</Label>
            <Input
              id="console-api-key"
              type="password"
              autoComplete="current-password"
              autoFocus
              spellCheck={false}
              placeholder="cr_live_…"
              className="font-mono text-xs"
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Validated against <span className="font-mono">/v2/me</span> and stored in an encrypted HttpOnly session cookie.
            </p>
          </div>
          <PixelButton type="submit" size="hero" className="w-full" disabled={busy || !apiKey.trim()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <KeyRound className="size-3.5" aria-hidden="true" />}
            {busy ? "Signing in…" : "Sign in"}
          </PixelButton>
        </form>
      </div>
    </AuthLayout>
  );
}
