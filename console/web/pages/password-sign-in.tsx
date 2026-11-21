import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelButton } from "@/components/ui/pixel-button";
import { api } from "@/lib/api";

export const MIN_PASSWORD = 8;

function finishSignIn(accepted: string | undefined, onSignedIn: () => void) {
  if (accepted) {
    location.assign(accepted);
    return;
  }
  history.replaceState(null, "", "/console/");
  dispatchEvent(new PopStateEvent("popstate"));
  onSignedIn();
}

export function PasswordForm({
  onSignedIn,
  next,
  secondary = false,
}: {
  onSignedIn: () => void;
  next?: string;
  secondary?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ next?: string }>("/console/auth/password", {
        method: "POST",
        body: { email: email.trim(), password, ...(next ? { next } : {}) },
      });
      finishSignIn(result.next && result.next === next ? result.next : undefined, onSignedIn);
    } catch (caught) {
      setError((caught as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={event => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
        />
      </div>
      <PixelButton
        size="hero"
        type="submit"
        variant={secondary ? "secondary" : undefined}
        className="w-full"
        loading={busy}
        disabled={!email.trim() || !password || busy}
      >
        Sign in with email
      </PixelButton>
    </form>
  );
}

export function SignUpForm({
  onSignedIn,
  next,
}: {
  onSignedIn: () => void;
  next?: string;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ next?: string }>("/console/auth/signup", {
        method: "POST",
        body: {
          email: email.trim(),
          password,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(next ? { next } : {}),
        },
      });
      finishSignIn(result.next && result.next === next ? result.next : undefined, onSignedIn);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <ErrorAlert error={error || undefined} title="Sign-up failed" className="mb-0" />
      <div className="grid gap-1.5">
        <Label htmlFor="signup-name">Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input
          id="signup-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="signup-email">Email</Label>
        <Input
          id="signup-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={event => setEmail(event.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="signup-password">Password</Label>
        <Input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">At least {MIN_PASSWORD} characters.</p>
      </div>
      <PixelButton
        size="hero"
        type="submit"
        className="w-full"
        loading={busy}
        disabled={!email.trim() || password.length < MIN_PASSWORD || busy}
      >
        Create account
      </PixelButton>
    </form>
  );
}
