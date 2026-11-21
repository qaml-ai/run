import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatUsd, type Me } from "@/lib/api";

export function AccountPage({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const apiBase = `${location.origin}/v2`;

  return (
    <>
      <PageHeader title="Settings" description="Tenant details, API endpoint, and console session." docs="overview" />
      <section className="bg-card mb-6 border p-5">
        <h2 className="mb-4 text-base font-semibold">Tenant</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium">{me.name}</dd>
          {(me.email || me.login) && (
            <>
              <dt className="text-muted-foreground">Signed in as</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{me.email ?? me.login}</span>
                {me.signIn && <Badge variant="outline">{me.signIn}</Badge>}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Tenant ID</dt>
          <dd className="inline-flex items-center gap-1 font-mono text-xs">
            {me.tenantId}
            <CopyButton value={me.tenantId} label="Copy tenant ID" />
          </dd>
          <dt className="text-muted-foreground">Tier</dt>
          <dd><Badge variant="secondary">{me.tier}</Badge></dd>
          <dt className="text-muted-foreground">Balance</dt>
          <dd className="font-mono">{formatUsd(me.balanceUsd)}</dd>
          <dt className="text-muted-foreground">Concurrency</dt>
          <dd className="font-mono">{me.busyAgents.active} / {me.busyAgents.limit} busy agents</dd>
          <dt className="text-muted-foreground">v2 API endpoint</dt>
          <dd className="inline-flex items-center gap-1 font-mono text-xs">
            {apiBase}
            <CopyButton value={apiBase} label="Copy API endpoint" />
          </dd>
        </dl>
      </section>

      <section className="bg-card border p-5">
        <h2 className="text-base font-semibold">Console session</h2>
        <p className="text-muted-foreground mt-1 mb-4 max-w-2xl text-sm">
          Clears the encrypted console session cookie in this browser. Your API keys remain active and can be revoked under API keys.
        </p>
        <ErrorAlert error={error} />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await api("/console/auth/logout", { method: "POST", body: {} });
              location.assign("/console/");
            } catch (caught) {
              setError((caught as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <LogOut />}Sign out
        </Button>
      </section>
    </>
  );
}
