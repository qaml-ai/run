import { useState, type FormEvent } from "react";
import { FileCog, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmButton, EmptyState, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Definition } from "@/lib/api";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const BUILTINS = [
  { id: "web_fetch", label: "web_fetch", help: "read public web pages as text" },
  { id: "web_search", label: "web_search", help: "search the web (a brave key on Models & keys, or the platform's, billed per search)" },
  { id: "schedule", label: "schedule", help: "set, list and cancel its own wake-ups" },
];
const DEFAULT = "default";
/** Pretty JSON for an optional list field, or empty. */
const pretty = (value: unknown) => value === undefined ? "" : JSON.stringify(value, null, 2);

/** A list's entries without what the API shows of stored credentials, which it keeps when they are left out. */
const withoutCredentials = <T extends { headerNames?: string[]; auth?: unknown }>(list?: T[]) => list?.map(({ headerNames: _names, auth: _auth, ...entry }) => entry);

/** A JSON list typed into a textarea: undefined when empty, or an error message. */
function parseList(label: string, text: string): { value?: unknown[]; error?: string } {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? { value } : { error: `${label} must be a JSON array` };
  } catch { return { error: `${label} is not valid JSON` }; }
}

function DefinitionDialog({ definition, onClose, onSaved }: { definition?: Definition; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(definition?.name ?? "");
  const [model, setModel] = useState(definition?.model ?? "");
  const [thinking, setThinking] = useState(definition?.thinkingLevel ?? DEFAULT);
  const [systemPrompt, setSystemPrompt] = useState(definition?.systemPrompt ?? "");
  const [ttl, setTtl] = useState(definition?.limits?.ttlSeconds === null ? "never" : String(definition?.limits?.ttlSeconds ?? ""));
  const [builtins, setBuiltins] = useState(definition?.builtins ?? []);
  // Stored credentials are never shown; a server edited without headers or auth keeps them.
  const [servers, setServers] = useState(pretty(withoutCredentials(definition?.mcpServers)));
  // A spec is fetched again on save; the listed operations are for reading, not sending back.
  const [apis, setApis] = useState(pretty(withoutCredentials(definition?.openApi)?.map(({ tools: _tools, ...api }) => api)));
  const secured = [...definition?.mcpServers ?? [], ...definition?.openApi ?? []].filter(entry => entry.headerNames || entry.auth).map(entry => entry.name);
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState<{ accepted: string[]; failed: { agent: string; error: string }[] }>();
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsedServers = parseList("MCP servers", servers), parsedApis = parseList("OpenAPI", apis);
    const invalid = parsedServers.error ?? parsedApis.error;
    if (invalid) { setError(invalid); return; }
    const ttlSeconds = ttl.trim() === "never" ? null : ttl.trim() ? Number(ttl) : undefined;
    // On edit, a cleared field is null: the definition drops it.
    const clear = definition ? null : undefined;
    const body = {
      name: name.trim(), model: model.trim() || clear, systemPrompt: systemPrompt.trim() || clear,
      thinkingLevel: thinking === DEFAULT ? clear : thinking, mcpServers: parsedServers.value ?? clear, openApi: parsedApis.value ?? clear, builtins: builtins.length ? builtins : clear,
      limits: ttlSeconds === undefined ? clear : { ttlSeconds },
      ...(definition ? { revision: definition.revision, ...(apply ? { apply: "all" } : {}) } : {}),
    };
    setBusy(true); setError(undefined);
    try {
      if (definition) {
        const updated = await api<Definition & { applied?: typeof applied }>(`/v1/definitions/${definition.id}`, { method: "PATCH", body });
        onSaved();
        if (updated.applied) { setApplied(updated.applied); return; }
      } else {
        await api<Definition>("/v1/definitions", { body });
        onSaved();
      }
      onClose();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  if (applied) return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Applied to {applied.accepted.length} agent{applied.accepted.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>Each takes the new revision between its turns.</DialogDescription>
        </DialogHeader>
        {applied.failed.length > 0 && <ErrorAlert title={`${applied.failed.length} could not be reached`} error={applied.failed.map(entry => `${entry.agent}: ${entry.error}`).join("\n")} />}
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{definition ? `Edit ${definition.name}` : "New definition"}</DialogTitle>
            <DialogDescription>
              {definition ? `Revision ${definition.revision}. Saving makes a new revision, which new agents get; existing agents keep theirs unless you apply it.`
                : "A reusable agent configuration. Create agents from it with POST /v1/agents {\"definition\": id}, or pick it for a channel."}
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-name">Name</Label>
            <Input id="definition-name" autoFocus value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-model">Model</Label>
              <Input id="definition-model" placeholder="Runtime default, or e.g. anthropic/claude-sonnet-5" value={model} onChange={event => setModel(event.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Thinking</Label>
              <Select value={thinking} onValueChange={setThinking}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Default</SelectItem>
                  {THINKING.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="definition-ttl">Lifetime (s)</Label>
              <Input id="definition-ttl" className="w-32" placeholder="86400" value={ttl} onChange={event => setTtl(event.target.value)} />
            </div>
          </div>
          <p className="text-muted-foreground -mt-2 text-xs">Lifetime: seconds each agent lives, or “never” to keep agents until they are deleted.</p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-prompt">System prompt</Label>
            <Textarea id="definition-prompt" rows={5} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Built-in tools</Label>
            {BUILTINS.map(builtin => (
              <label key={builtin.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={builtins.includes(builtin.id)} onChange={event => setBuiltins(current => event.target.checked ? [...current, builtin.id] : current.filter(entry => entry !== builtin.id))} />
                <span className="font-mono">{builtin.label}</span><span className="text-muted-foreground">{builtin.help}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-servers">MCP servers <span className="text-muted-foreground font-normal">(JSON: [{"{"}name, url, auth?: {"{"}type: "bearer", token{"}"}, headers?, allowTools?, exposure?{"}"}], called by the runtime)</span></Label>
            <Textarea id="definition-servers" rows={4} className="font-mono text-xs" placeholder='[{"name": "kb", "url": "https://…/mcp", "auth": {"type": "bearer", "token": "…"}}]' value={servers} onChange={event => setServers(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="definition-openapi">OpenAPI <span className="text-muted-foreground font-normal">(JSON: [{"{"}name, spec: URL, baseUrl?, auth?, headers?, allowTools?, exposure?{"}"}]; each operation becomes a tool, and saving fetches the spec again)</span></Label>
            <Textarea id="definition-openapi" rows={4} className="font-mono text-xs" placeholder='[{"name": "pets", "spec": "https://…/openapi.json", "auth": {"type": "bearer", "token": "…"}}]' value={apis} onChange={event => setApis(event.target.value)} />
            {definition?.openApi?.map(api => <p key={api.name} className="text-muted-foreground text-xs"><span className="font-mono">{api.name}</span>: {api.tools.length} operation{api.tools.length === 1 ? "" : "s"} at {api.baseUrl}</p>)}
          </div>
          {secured.length > 0 && <p className="text-muted-foreground -mt-2 text-xs">Credentials stored for {secured.join(", ")} are kept unless you give headers or auth for it.</p>}
          {definition && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={apply} onChange={event => setApply(event.target.checked)} />
              Apply to existing agents made from this definition
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy && <Loader2 className="animate-spin" />}{definition ? "Save" : "Create definition"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionsPage() {
  const definitions = useApi<Definition[]>("/v1/definitions");
  const [editing, setEditing] = useState<Definition | "new">();
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader title="Definitions" description="Reusable agent configurations: model, prompt and tools. Agents and channels are made from them."
        actions={<Button size="sm" onClick={() => setEditing("new")}><Plus />New definition</Button>} />
      <ErrorAlert error={definitions.error ?? error} />
      {!definitions.data ? <Skeleton className="h-32 w-full" /> : definitions.data.length === 0 ? (
        <EmptyState icon={<FileCog />} title="No definitions">Create one to make agents with the same configuration from your app or a channel.</EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Model</TableHead><TableHead>Revision</TableHead><TableHead className="hidden lg:table-cell">Updated</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {definitions.data.map(definition => (
                <TableRow key={definition.id}>
                  <TableCell className="font-medium">{definition.name}<div className="text-muted-foreground font-mono text-xs">{definition.id}</div></TableCell>
                  <TableCell className="font-mono text-xs">{definition.model ?? <span className="text-muted-foreground">default</span>}</TableCell>
                  <TableCell><Badge variant="outline">{definition.revision}</Badge></TableCell>
                  <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">{formatTime(definition.updatedAt)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="xs" variant="outline" className="mr-2" onClick={() => setEditing(definition)}>Edit</Button>
                    <ConfirmButton size="xs" label="Delete" title={`Delete “${definition.name}”?`} description="Agents already made from it keep their configuration. A channel that uses it must be pointed at another first." confirm="Delete definition"
                      onConfirm={async () => { try { await api(`/v1/definitions/${definition.id}`, { method: "DELETE" }); await definitions.reload(); } catch (caught) { setError((caught as Error).message); } }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing && <DefinitionDialog definition={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => void definitions.reload()} />}
    </>
  );
}
