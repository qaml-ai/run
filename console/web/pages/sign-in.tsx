import { useState } from "react";
import { Github } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PixelButton } from "@/components/ui/pixel-button";
import { Separator } from "@/components/ui/separator";
import { AuthLayout } from "@/components/auth-layout";
import { ErrorAlert } from "@/components/common";
import { useApi } from "@/lib/api";
import { consoleLoginUrl, discordInstallNext } from "@/lib/discord-setup";
import { startNext } from "@/lib/onboarding";
import { ForgotPasswordForm, PasswordForm, SignUpForm } from "@/pages/password-sign-in";

/** Google's "G", in the button's color: the console is monochrome. */
function GoogleMark({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor"><path d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" /></svg>;
}

/** The sign-in page's form: signing in, signing up (/console/signup) or asking for a reset link (/console/reset). */
type Mode = "signin" | "signup" | "forgot";
const MODE_PATHS: Record<Mode, string> = { signin: "/console/", signup: "/console/signup", forgot: "/console/reset" };

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  // Where to go after: resuming adding Camel to Discord, a use-case start (a landing page's deep link), or an app's
  // consent page that linked here (the server checks it).
  const next = discordInstallNext(location.pathname, location.search) ?? startNext(location.pathname, location.search)
    ?? (new URLSearchParams(location.search).get("next") || undefined);
  const methods = useApi<{ github: boolean; google?: boolean; password?: boolean; org?: string; open?: boolean; signup?: boolean; reset?: boolean }>("/console/auth/methods");
  const [mode, setMode] = useState<Mode>(() => location.pathname === MODE_PATHS.signup ? "signup" : location.pathname === MODE_PATHS.forgot ? "forgot" : "signin");
  const choose = (chosen: Mode) => { history.replaceState(null, "", MODE_PATHS[chosen] + location.search); setMode(chosen); };
  const providers = !!(methods.data?.github || methods.data?.google);
  const error = new URLSearchParams(location.search).get("error") ?? "";
  const deleted = new URLSearchParams(location.search).get("deleted") === "1";
  // Sign-up and reset by email exist only where the runtime has account mail; otherwise this is the sign-in page alone.
  const shown: Mode = mode === "signup" && methods.data?.signup ? "signup" : mode === "forgot" && methods.data?.reset ? "forgot" : "signin";
  // Every call to action here is a brand (pixel) button, as on camelStream's sign-in.
  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{shown === "signup" ? "Create your camelRun account" : shown === "forgot" ? "Reset your password" : "camelRun"}</h1>
          {shown === "signin" && <p className="text-muted-foreground text-sm text-balance">Sign in to manage your agents, model keys and API keys.</p>}
        </div>
        {deleted && <Alert className="mb-0"><AlertTitle>Your account is deleted</AlertTitle><AlertDescription>Its data is being removed now. Signing in again makes a new, empty account.</AlertDescription></Alert>}
        <ErrorAlert error={error || undefined} title="Sign-in failed" className="mb-0" />
        {shown !== "forgot" && providers && (
          <div className="flex flex-col gap-3">
            {methods.data!.github && <PixelButton size="hero" href={consoleLoginUrl("github", next)} className="w-full"><Github className="size-3.5" aria-hidden="true" />Continue with GitHub</PixelButton>}
            {methods.data!.google && <PixelButton size="hero" href={consoleLoginUrl("google", next)} className="w-full"><GoogleMark className="size-3.5" />Continue with Google</PixelButton>}
            <p className="text-muted-foreground text-center text-xs text-balance">{!methods.data!.github
              ? "Any Google account can sign up."
              : methods.data!.open
                ? `Any GitHub${methods.data!.google ? " or Google" : ""} account can sign up.`
                : `For members of the ${methods.data!.org} GitHub organization${methods.data!.google ? ", or anyone with a Google account" : ""}.`}</p>
          </div>
        )}
        {methods.data?.password && <>
          {shown !== "forgot" && providers && <div className="text-muted-foreground flex items-center gap-3 text-xs"><Separator className="flex-1" />or<Separator className="flex-1" /></div>}
          {shown === "signup" ? <SignUpForm next={next} />
            : shown === "forgot" ? <ForgotPasswordForm next={next} />
            : <PasswordForm onSignedIn={onSignedIn} next={next} secondary={providers} onForgot={methods.data.reset ? () => choose("forgot") : undefined} />}
          {(methods.data.signup || shown !== "signin") && <p className="text-muted-foreground text-center text-sm">
            {shown === "signin"
              ? <>New to camelRun? <button type="button" className="text-foreground underline underline-offset-4" onClick={() => choose("signup")}>Sign up with email</button></>
              : <>{shown === "signup" ? "Have an account?" : "Remembered it?"} <button type="button" className="text-foreground underline underline-offset-4" onClick={() => choose("signin")}>Sign in</button></>}
          </p>}
        </>}
      </div>
    </AuthLayout>
  );
}
