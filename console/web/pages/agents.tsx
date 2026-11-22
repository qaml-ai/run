import { useState, type FormEvent } from "react";
import { Bot, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import {
  api,
  formatAgo,
  useApi,
  type AgentSummary,
  type BuiltinSuite,
  type Definition,
  type Model,
  type RepoRecord,
} from "@/lib/api";
import { useAgentPreviews } from "@/lib/agent-previews";
import { docsUrl } from "@/lib/docs";
import { Link, navigate } from "@/lib/router";
import { cn } from "@/lib/utils";

const FILTERS = {
  all: "All",
  running: "Running",
  repo: "With repository",
} as const;
type Filter = keyof typeof FILTERS;

const BUILTINS: BuiltinSuite[] = ["files", "bash", "codemode", "web_search", "web_fetch", "images", "delegate", "workflows", "human"];

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [definition, setDefinition] = useState("none");
  const [repoId, setRepoId] = useState("none");
  const [instructions, setInstructions] = useState("");
  const [builtins, setBuiltins] = useState<BuiltinSuite[]>(["files", "web_fetch"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const models = useApi<Model[]>("/v2/models");
  const definitions = useApi<{ definitions: Definition[] }>("/v2/definitions");
  const repos = useApi<{ repos: RepoRecord[] }>("/v2/repos");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    setBusy(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = {
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(definition !== "none" ? { definition } : {}),
        ...(repoId !== "none" ? { repoId } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        builtins,
      };
      const created = await api<{ id: string }>(`/v2/agents/${encodeURIComponent(trimmedKey)}`, {
        method: "PUT",
        body,
      });
      onCreated(created.id);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>
              Creates or updates a durable keyed agent via <code className="font-mono">PUT /v2/agents/:key</code>.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-key">Key</Label>
            <Input
              id="agent-key"
              autoFocus
              placeholder="e.g. support-bot or ticket-123"
              className="font-mono text-xs"
              value={key}
              onChange={event => setKey(event.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-model">Model (optional)</Label>
              <Input
                id="agent-model"
                list="agent-model-options"
                placeholder="Runtime default"
                className="font-mono text-xs"
                value={model}
                onChange={event => setModel(event.target.value)}
              />
              <datalist id="agent-model-options">
                {[...(models.data ?? [])]
                  .sort((a, b) => Number(b.available) - Number(a.available))
                  .map(entry => (
                    <option key={entry.id} value={entry.id}>
                      {entry.available ? entry.id : `${entry.id} — needs key`}
                    </option>
                  ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Definition (optional)</Label>
              <Select value={definition} onValueChange={setDefinition}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {definitions.data?.definitions.map(def => (
                    <SelectItem key={def.slug} value={def.slug}>{def.slug}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Repository (optional)</Label>
            <Select value={repoId} onValueChange={setRepoId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (create on demand)</SelectItem>
                {repos.data?.repos.map(repo => (
                  <SelectItem key={repo.repoId} value={repo.repoId}>
                    {repo.name} ({repo.repoId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-instructions">System instructions</Label>
            <Textarea
              id="agent-instructions"
              rows={4}
              placeholder="You are a concise, helpful assistant."
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Built-in suites</Label>
            <div className="flex flex-wrap gap-3">
              {BUILTINS.map(suite => (
                <label key={suite} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={builtins.includes(suite)}
                    onChange={event =>
                      setBuiltins(curr => (event.target.checked ? [...curr, suite] : curr.filter(item => item !== suite)))
                    }
                  />
                  <span className="font-mono">{suite}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!key.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AgentsPage() {
  const agentsRes = useApi<{ agents: AgentSummary[] }>("/v2/agents", 10_000);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);

  const all = agentsRes.data?.agents;
  const shown = (all ?? []).filter(agent => {
    if (filter === "running" && !agent.running) return false;
    if (filter === "repo" && !agent.repoId) return false;
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      return `${agent.key} ${agent.id} ${agent.model} ${agent.definition ?? ""}`.toLowerCase().includes(needle);
    }
    return true;
  });
  const previews = useAgentPreviews(shown.slice(0, 30));
  const filtered = !!query.trim() || filter !== "all";

  return (
    <>
      <PageHeader
        title="Agents"
        description="Your durable keyed agents. Pick one to chat, stream turns, inspect files, or manage schedules."
        docs="concepts"
        actions={
          <>
            {!!all?.length && (
              <div className="relative">
                <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
                <Input
                  type="search"
                  aria-label="Search agents"
                  placeholder="Search key, id or model"
                  className="w-56 pl-7"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => void agentsRes.reload()}>
              <RefreshCw />Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus />New agent
            </Button>
          </>
        }
      />
      <ErrorAlert error={agentsRes.error} />
      {!all ? (
        <Skeleton className="h-40 w-full" />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No agents yet"
          action={
            <>
              <Button size="sm" onClick={() => setCreating(true)}><Plus />New agent</Button>
              <Button size="sm" variant="outline" asChild><Link to="start">Get started</Link></Button>
              <Button size="sm" variant="outline" asChild>
                <a href={docsUrl("concepts")} target="_blank" rel="noreferrer">How agents work</a>
              </Button>
            </>
          }
        >
          An agent is a durable conversation backed by its own Durable Object and optional Git-backed repository. Create one here or via PUT /v2/agents/:key.
        </EmptyState>
      ) : (
        <>
          <div role="group" aria-label="Filter agents" className="mb-3 flex flex-wrap gap-2">
            {(Object.keys(FILTERS) as Filter[]).map(key => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  "focus-visible:ring-ring border px-2.5 py-1 text-xs outline-none focus-visible:ring-2",
                  filter === key ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-accent",
                )}
              >
                {FILTERS[key]}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <EmptyState
              icon={<Bot />}
              title="No agents match"
              action={
                filtered ? (
                  <Button size="sm" variant="outline" onClick={() => { setQuery(""); setFilter("all"); }}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              Nothing here matches the current search and filter.
            </EmptyState>
          ) : (
            <div className="grid gap-3">
              {shown.map(agent => (
                <AgentPreview key={agent.id} agent={agent} preview={previews[agent.id]} />
              ))}
            </div>
          )}
        </>
      )}
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={id => {
            setCreating(false);
            navigate(`agents/${id}`);
          }}
        />
      )}
    </>
  );
}

export function AgentPreview({ agent, preview }: { agent: AgentSummary; preview?: string }) {
  return (
    <Link
      aria-label={agent.key}
      to={`agents/${agent.id}`}
      className="min-w-0 flex-1 border bg-card p-4 transition-colors hover:bg-accent focus-visible:ring-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{agent.key}</span>
        <Badge variant={agent.running ? "live" : "outline"}>{agent.running ? "Working" : "Idle"}</Badge>
        <span className="text-muted-foreground font-mono text-xs">{agent.model}</span>
        {agent.definition && <Badge variant="secondary">{agent.definition}</Badge>}
        {agent.repoId && <Badge variant="outline">repo</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{agent.running ? "now" : formatAgo(agent.updatedAt)}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {preview === undefined ? "Loading conversation…" : preview || "Start a conversation"}
      </p>
    </Link>
  );
}
