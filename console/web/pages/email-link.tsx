import { useEffect, useState, type FormEvent } from "react";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { MIN_PASSWORD } from "@/pages/password-sign-in";

type Link = { purpose: "verify" | "add" | "reset"; email: string };

/**
 * A link mailed to finish a sign-up or adding a password (/console/verify#token), or to reset a password
 * (/console/reset#token). The token stays in the fragment, which never reaches server logs or referrers; the page posts
 * it. Finishing signs in, then goes on to where the person started (an app's consent page) or the console.
 */
export function EmailLinkPage() {
  const [token] = useState(() => location.hash.slice(1));
  const [link, setLink] = useState<Link | null>();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Link>("/console/auth/link", { body: { token } }).then(setLink, () => setLink(null));
  }, [token]);
  const reset = link?.purpose === "reset";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const done = await api<{ next?: string }>(reset ? "/console/auth/reset" : "/console/auth/verify", { body: { token, password } });
      location.assign(done.next ?? "/console/");
    } catch (caught) { setError((caught as Error).message); setPassword(""); setConfirm(""); setBusy(false); }
  }
  const mismatch = reset && !!confirm && password !== confirm;
  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        {link === undefined ? <Skeleton className="h-48 w-full" /> : link === null ? <>
          <h1 className="text-xl font-semibold tracking-tight">This link doesn't work anymore</h1>
          <p className="text-muted-foreground text-sm">Links work once, and expire: a sign-up's after 24 hours, a password reset's after an hour. Ask for a new one from the sign-in page.</p>
          <PixelButton size="hero" href="/console/" className="w-full">Go to sign-in</PixelButton>
        </> : <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{reset ? "Choose a new password" : link.purpose === "add" ? "Confirm your sign-in address" : "Finish creating your account"}</h1>
            <p className="text-muted-foreground text-sm">{reset
              ? <>For <span className="text-foreground break-all">{link.email}</span>. Every session signed in with the old password ends.</>
              : <>Enter the password you chose for <span className="text-foreground break-all">{link.email}</span> to confirm it.</>}</p>
          </div>
          <ErrorAlert error={error || undefined} title={reset ? "Not changed" : "Not confirmed"} className="mb-0" />
          {/* For password managers: the account the password is for. */}
          <input type="email" autoComplete="username" value={link.email} readOnly hidden />
          <div className="grid gap-1.5">
            <Label htmlFor="link-password">{reset ? "New password" : "Password"}</Label>
            <Input id="link-password" type="password" autoComplete={reset ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} />
            {reset && <p className="text-muted-foreground text-xs">At least {MIN_PASSWORD} characters.</p>}
          </div>
          {reset && <div className="grid gap-1.5">
            <Label htmlFor="link-confirm">Confirm new password</Label>
            <Input id="link-confirm" type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} />
            {mismatch && <p className="text-destructive text-xs">The passwords differ.</p>}
          </div>}
          <PixelButton size="hero" type="submit" className="w-full" loading={busy}
            disabled={busy || !password || (reset && (password.length < MIN_PASSWORD || password !== confirm))}>
            {reset ? "Set password and sign in" : "Confirm and sign in"}
          </PixelButton>
        </form>}
      </div>
    </AuthLayout>
  );
}
