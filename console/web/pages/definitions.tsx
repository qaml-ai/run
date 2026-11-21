import { useState, type FormEvent } from "react";
import { FileCog, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type BuiltinSuite, type Definition, type Model } from "@/lib/api";

const BUILTINS: { id: BuiltinSuite; help: string }[] = [
  { id: "files", help: "read, write, list, and search repository files" },
  { id: "bash", help: "execute shell commands inside a Firecracker VM sandbox" },
  { id: "codemode", help: "run QuickJS code to compose tools" },
  { id: "web_fetch", help: "fetch public web pages" },
  { id: "web_search", help: "search the web" },
  { id: "images", help: "generate and inspect images" },
  { id: "delegate", help: "spawn and await sub-agents" },
  { id: "workflows", help: "run deterministic replay workflows" },
  { id: "human", help: "pause for human questions and tool approvals" },
];

const pretty = (value: unknown) => (value === undefined || (Array.isArray(value) && value.length === 0) ? "" : JSON.stringify(value, null, 2));

function parseList(label: string, text: string): { value?: unknown[]; error?: string } {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? { value } : { error: `${label} must be a JSON array` };
  } catch {
    return { error: `${label} is not valid JSON` };
  }
}

export function DefinitionDialog({
  definition,
  onClose,
  onSaved,
}: {
  definition?: Definition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cfg = definition?.config;
  const [slug, setSlug] = useState(definition?.slug ?? "");
  const [model, setModel] = useState(cfg?.model ?? "");
  const [keyScope, setKeyScope] = useState(cfg?.keyScope ?? "");
  const [instructions, setInstructions] = useState(cfg?.instructions ?? "");
  const [spendLimitUsd, setSpendLimitUsd] = useState(cfg?.spendLimitUsd !== undefined ? String(cfg.spendLimitUsd) : "");
  const [idleTtlSeconds, setIdleTtlSeconds] = useState(cfg?.idleTtlSeconds !== undefined ? String(cfg.idleTtlSeconds) : "");
  const [builtins, setBuiltins] = useState<BuiltinSuite[]>(cfg?.builtins ?? []);
  const [servers, setServers] = useState(pretty(cfg?.mcpServers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const models = useApi<Model[]>("/v2/models");

  async function save(event: FormEvent) {
    event.preventDefault();
    const cleanSlug = slug.trim();
    if (!cleanSlug) return;
    const parsedServers = parseList("MCP servers", servers);
    if (parsedServers.error) {
      setError(parsedServers.error);
      return;
    }
    const body: Record<string, unknown> = {
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(keyScope.trim() ? { keyScope: keyScope.trim() } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      builtins,
      ...(parsedServers.value ? { mcpServers: parsedServers.value } : {}),
      ...(spendLimitUsd.trim() ? { spendLimitUsd: Number(spendLimitUsd) } : {}),
      ...(idleTtlSeconds.trim() ? { idleTtlSeconds: Number(idleTtlSeconds) } : {}),
    };
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v2/definitions/${encodeURIComponent(cleanSlug)}`, { method: "PUT", body });
      onSaved();
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{definition ? `Edit ${definition.slug}` : "New definition"}</DialogTitle>
            <DialogDescription>
              Reusable agent configuration saved via <code className="font-mono">PUT /v2/definitions/:slug</code>. Reference it by slug when upserting agents or creating channels.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-slug">Slug</Label>
            <Input
              id="definition-slug"
              autoFocus={!definition}
              disabled={!!definition}
              placeholder="e.g. support-agent"
              className="font-mono text-xs"
              value={slug}
              onChange={event => setSlug(event.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-model">Model</Label>
              <Input
                id="definition-model"
                list="definition-model-options"
                placeholder="Runtime default, or e.g. openai/gpt-5"
                className="font-mono text-xs"
                value={model}
                onChange={event => setModel(event.target.value)}
              />
              <datalist id="definition-model-options">
                {models.data?.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.available ? entry.id : `${entry.id} — provider key required`}
                  </option>
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-key-scope">Key scope (optional)</Label>
              <Input
                id="definition-key-scope"
                placeholder="Tenant default"
                className="font-mono text-xs"
                value={keyScope}
                onChange={event => setKeyScope(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-spend">Spend limit (USD)</Label>
              <Input
                id="definition-spend"
                type="number"
                min="0"
                step="0.01"
                placeholder="10"
                className="font-mono text-xs"
                value={spendLimitUsd}
                onChange={event => setSpendLimitUsd(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-ttl">Idle TTL (seconds)</Label>
              <Input
                id="definition-ttl"
                type="number"
                min="0"
                placeholder="86400"
                className="font-mono text-xs"
                value={idleTtlSeconds}
                onChange={event => setIdleTtlSeconds(event.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-instructions">Instructions</Label>
            <Textarea
              id="definition-instructions"
              rows={5}
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Built-in suites</Label>
            {BUILTINS.map(b => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={builtins.includes(b.id)}
                  onChange={event =>
                    setBuiltins(current => (event.target.checked ? [...current, b.id] : current.filter(x => x !== b.id)))
                  }
                />
                <span className="font-mono text-xs">{b.id}</span>
                <span className="text-muted-foreground text-xs">{b.help}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-servers">
              MCP servers <span className="text-muted-foreground font-normal">(JSON array of {"{name, url, headers?, allowTools?}"})</span>
            </Label>
            <Textarea
              id="definition-servers"
              rows={3}
              className="font-mono text-xs"
              placeholder='[{"name": "docs", "url": "https://…/mcp"}]'
              value={servers}
              onChange={event => setServers(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !slug.trim()}>
              {busy && <Loader2 className="animate-spin" />}{definition ? "Save" : "Create definition"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionsPage() {
  const definitionsRes = useApi<{ definitions: Definition[] }>("/v2/definitions");
  const [editing, setEditing] = useState<Definition | "new">();
  const [error, setError] = useState<string>();

  const list = definitionsRes.data?.definitions;

  return (
    <>
      <PageHeader
        title="Definitions"
        docs="definitions"
        description="Reusable agent configurations: model, instructions, built-in suites, and MCP servers."
        actions={<Button size="sm" onClick={() => setEditing("new")}><Plus />New definition</Button>}
      />
      <ErrorAlert error={definitionsRes.error ?? error} />
      {!list ? (
        <Skeleton className="h-32 w-full" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<FileCog />}
          title="No definitions"
          action={<Button size="sm" onClick={() => setEditing("new")}><Plus />New definition</Button>}
        >
          A definition is a reusable template keyed by slug. Pass <code className="font-mono">definition</code> when upserting agents or creating channels.
        </EmptyState>
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="hidden md:table-cell">Built-ins</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map(definition => (
                <TableRow key={definition.slug}>
                  <TableCell className="font-mono text-xs font-medium">{definition.slug}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {definition.config.model ?? <span className="text-muted-foreground">default</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(definition.config.builtins ?? []).length > 0
                        ? definition.config.builtins!.map(b => <Badge key={b} variant="outline">{b}</Badge>)
                        : <span className="text-muted-foreground text-xs">—</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
                    {formatTime(definition.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="xs" variant="outline" className="mr-2" onClick={() => setEditing(definition)}>Edit</Button>
                    <ConfirmButton
                      size="xs"
                      label="Delete"
                      title={`Delete “${definition.slug}”?`}
                      description="Agents already created from this definition keep their configuration."
                      confirm="Delete definition"
                      onConfirm={async () => {
                        try {
                          await api(`/v2/definitions/${encodeURIComponent(definition.slug)}`, { method: "DELETE" });
                          await definitionsRes.reload();
                        } catch (caught) {
                          setError((caught as Error).message);
                        }
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && (
        <DefinitionDialog
          definition={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => void definitionsRes.reload()}
        />
      )}
    </>
  );
}
