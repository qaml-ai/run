import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorAlert, PageHeader } from "@/components/common";
import { api, useApi, type AgentSummary, type Workspace } from "@/lib/api";

interface Connection { id: string; agent: string; provider: string; leaseSeconds: number; dailySeconds: number; session: { state: string; recoveryRequired?: boolean; expiresAt: number; error?: string } | null }
interface Usage { workspace: string | null; provider: string; sessions: number; seconds: number }
export function ComputersPage() {
  const connections = useApi<Connection[]>("/v1/computers", 10000), agents = useApi<AgentSummary[]>("/v1/agents");
  const usage = useApi<Usage[]>("/v1/computers/usage", 30000), workspaces = useApi<Workspace[]>("/v1/workspaces");
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [agent, setAgent] = useState(""), [provider, setProvider] = useState("modal");
  const [apiKey, setKey] = useState(""), [tokenId, setTokenId] = useState(""), [url, setUrl] = useState(""), [projectId, setProjectId] = useState("");
  const [seconds, setSeconds] = useState(900), [daily, setDaily] = useState(3600), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  async function write(action: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await action(); setConfirmed([]); await connections.reload(); await usage.reload(); }
    catch (error) { setError(error); } finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Computers" description="Give an agent a Linux computer or remote browser. camelRun manages its session; compute is charged to your connected provider account." />
    <ErrorAlert error={error instanceof Error ? error : connections.error ?? agents.error ?? usage.error} />
    <form className="mb-8 grid max-w-xl gap-3" onSubmit={event => { event.preventDefault(); void write(async () => {
      const credentials = provider === "modal" ? { tokenId, tokenSecret: apiKey } : provider === "tunnel" ? { url, apiKey } : { apiKey, ...(projectId && provider === "browserbase" ? { projectId } : {}) };
      await api("/v1/computers", { body: { agent, provider, credentials, leaseSeconds: seconds, dailySeconds: daily } });
      setKey(""); setTokenId(""); setUrl(""); setProjectId("");
    }); }}>
      <label className="grid gap-1 text-sm">Agent<select className="h-10 border bg-background px-2" required value={agent} onChange={e => setAgent(e.target.value)}><option value="">Choose an agent</option>{agents.data?.filter(a => !connections.data?.some(c => c.agent === a.id)).map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Provider<select className="h-10 border bg-background px-2" value={provider} onChange={e => { setProvider(e.target.value); setKey(""); setTokenId(""); setProjectId(""); }}>
        {["modal", "daytona", "boat", "e2b", "browserbase", "tunnel"].map(p => <option key={p} value={p}>{p === "tunnel" ? "Your computer · Cloudflare Tunnel" : p}</option>)}</select></label>
      {provider === "modal" && <label className="grid gap-1 text-sm">Token ID<Input autoComplete="off" required value={tokenId} onChange={e => setTokenId(e.target.value)} /></label>}
      {provider === "tunnel" && <label className="grid gap-1 text-sm">Tunnel HTTPS origin<Input type="url" required value={url} onChange={e => setUrl(e.target.value)} /></label>}
      <label className="grid gap-1 text-sm">{provider === "modal" ? "Token secret" : provider === "tunnel" ? "Connection token" : "API key"}<Input type="password" autoComplete="new-password" required value={apiKey} onChange={e => setKey(e.target.value)} /></label>
      {provider === "browserbase" && <label className="grid gap-1 text-sm">Project ID (optional)<Input value={projectId} onChange={e => setProjectId(e.target.value)} /></label>}
      <label className="grid gap-1 text-sm">Maximum session seconds<Input type="number" min={60} max={900} required value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label>
      <label className="grid gap-1 text-sm">Daily computer seconds budget<Input type="number" min={seconds} max={86400} required value={daily} onChange={e => setDaily(Number(e.target.value))} /></label>
      <p className="text-sm text-muted-foreground">The agent gets computer tools on its next turn. Sessions expire at a fixed time; starting a new session creates an empty environment. Credentials are encrypted and never shown to the agent. Browserbase persistence requires a plan supporting keep-alive sessions.</p>
      {provider === "tunnel" && <p className="text-sm text-muted-foreground">Run the Cloudflare Tunnel runner on your machine, then enter its URL and connection token. Keep that runner online. See the Computers guide for setup instructions.</p>}
      <a className="text-sm underline" href="https://run.camelai.com/docs/guides/computers.md">Setup and recovery guide</a>
      <Button disabled={busy || !agent}>Connect computer</Button>
    </form>
    <div className="grid gap-3">{connections.data?.map(c => <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 border p-4"><div><strong>{agents.data?.find(a => a.id === c.agent)?.name || c.agent}</strong><p className="text-sm text-muted-foreground">{c.provider} · {c.leaseSeconds}s per session · {c.dailySeconds}s daily budget</p><p className="text-sm">{c.session ? `${c.session.state} · expires ${new Date(c.session.expiresAt).toLocaleString()}` : "No session started"}</p>{c.session?.error && <p className="text-sm text-destructive">{c.session.error}</p>}
      {c.session?.recoveryRequired && <div className="mt-2 grid gap-2"><label className="text-sm"><input type="checkbox" checked={confirmed.includes(c.id)} onChange={e => setConfirmed(ids => e.target.checked ? [...ids,c.id] : ids.filter(id => id !== c.id))} /> I checked the provider and removed any computer from this attempt.</label><Button variant="outline" disabled={busy || !confirmed.includes(c.id)} onClick={() => void write(() => api(`/v1/agents/${c.agent}/computer/confirm-cleanup`, { body: { providerCleanupConfirmed: true } }))}>Confirm provider cleanup</Button></div>}</div><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void write(() => api(`/v1/agents/${c.agent}/computer/stop`, { body: {} }))}>Stop session</Button><Button variant="outline" disabled={busy} onClick={() => void write(() => api(`/v1/computers/${c.id}`, { method: "DELETE" }))}>Disconnect</Button></div></div>)}</div>
    <h2 className="mb-3 mt-8 text-lg font-medium">Compute usage by workspace</h2>
    <p className="mb-3 text-sm text-muted-foreground">Allocated session time, capped at the configured expiry and separate from model spend. Your provider bills compute directly; cleanup delays can add provider charges beyond these figures.</p>
    {usage.data?.map((u, i) => <p className="text-sm" key={i}>{workspaces.data?.find(w => w.id === u.workspace)?.name ?? "Unassigned"} · {u.provider} · {u.sessions} sessions · {Math.round(Number(u.seconds))} seconds</p>)}
  </>;
}
