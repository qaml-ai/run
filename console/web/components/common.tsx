import { Component, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, ArrowUpRight, Check, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PIXEL_STYLE, StatusPanel } from "@/components/brand";
import { docsUrl, type DocsPage } from "@/lib/docs";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

/** A link to the docs page about what a page shows; it opens beside the console. */
export function LearnMore({ page, children = "Learn more" }: { page: DocsPage; children?: ReactNode }) {
  return <a href={docsUrl(page)} target="_blank" rel="noreferrer" className="text-foreground inline-flex items-center gap-0.5 whitespace-nowrap underline underline-offset-4">{children}<ArrowUpRight className="size-3" aria-hidden="true" /></a>;
}

export function PageHeader({ title, description, actions, docs }: { title: string; description?: ReactNode; actions?: ReactNode; docs?: DocsPage }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {(description || docs) && <p className="text-muted-foreground mt-1 text-sm">{description}{docs && <>{description && " "}<LearnMore page={docs} /></>}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A row of headline figures: labels in the body face, figures in Geist Mono, split by rules. */
export function Stats({ items }: { items: { label: string; value: ReactNode; extra?: ReactNode }[] }) {
  return (
    <dl className="mb-8 grid grid-cols-2 gap-6 lg:grid-cols-4">
      {items.map(item => (
        <div key={item.label} className="min-w-0 lg:border-l lg:pl-6 lg:first:border-l-0 lg:first:pl-0">
          <dt className="text-muted-foreground text-xs">{item.label}</dt>
          <dd className="text-foreground mt-1.5 font-mono text-2xl font-medium tabular-nums">{item.value}</dd>
          {item.extra}
        </div>
      ))}
    </dl>
  );
}

/** A page that fails to render shows an error in place of itself; the rest of the console stays usable. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <StatusPanel code="ERROR" label="Something went wrong" detail="The request could not be completed."
      action={<Button onClick={() => location.reload()}>Reload</Button>} />;
  }
}

export function ErrorAlert({ error, title = "Something went wrong", className }: { error?: { message: string } | string; title?: string; className?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" className={cn("mb-4", className)}>
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{typeof error === "string" ? error : error.message}</AlertDescription>
    </Alert>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} onClick={async () => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="bg-muted relative max-w-full min-w-0 border">
      {language && <span className="text-muted-foreground absolute top-2.5 left-3 text-[10px] uppercase tracking-[0.18em]" style={PIXEL_STYLE}>{language}</span>}
      <div className="absolute top-1 right-1"><CopyButton value={code} /></div>
      <pre className="overflow-x-auto p-3 pt-7 font-mono text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

/** A destructive action behind an explicit confirmation. */
export function ConfirmButton({ label, title, description, confirm, onConfirm, variant = "outline", size = "sm", icon }: {
  label: string; title: string; description: ReactNode; confirm: string; onConfirm: () => Promise<void> | void;
  variant?: "outline" | "destructive" | "ghost"; size?: "sm" | "xs" | "default"; icon?: ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button variant={variant} size={size}>{icon}{label}</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void onConfirm()}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** An empty list: what the thing is, and the one action to take (`action`). */
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="[&_svg]:size-6">{icon}</div>
      <p className="text-foreground text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** What a save answered it cannot do yet (`warnings`: builtins without a key), with the way to Models & keys. */
export function WarningsAlert({ warnings, className }: { warnings?: string[]; className?: string }) {
  if (!warnings?.length) return null;
  return (
    <Alert className={cn("mb-4", className)}>
      <AlertTriangle />
      <AlertTitle>Saved, but not everything will work yet</AlertTitle>
      <AlertDescription>
        {warnings.map(warning => <p key={warning}>{warning}</p>)}
        <Link className="underline underline-offset-4" to="models">Open Models &amp; keys</Link>
      </AlertDescription>
    </Alert>
  );
}
