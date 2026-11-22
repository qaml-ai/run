import { useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton, CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatNumber, formatTime, useApi, type Model, type ProviderEntry } from "@/lib/api";

const KNOWN_PROVIDERS = [
  "azure",
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "openrouter",
  "openai-responses",
  "openai-codex",
  "deepseek",
  "groq",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
  "moonshotai",
  "minimax",
  "zai",
  "baseten",
  "nvidia",
  "huggingface",
  "custom",
];
const API_STYLES = ["openai-chat", "openai-responses", "openai-codex", "anthropic", "gemini"] as const;
const DEFAULT_VISIBLE_MODELS = 100;

interface DisplayProvider {
  id: string;
  configured?: ProviderEntry;
  platformAvailable: boolean;
  modelCount: number;
}

function KeyDialog({
  provider,
  scope,
  onClose,
  onSaved,
}: {
  provider: DisplayProvider;
  scope: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.configured?.baseUrl ?? "");
  const [apiStyle, setApiStyle] = useState(provider.configured?.apiStyle ?? "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const target = scope
        ? `/v2/key-scopes/${encodeURIComponent(scope)}/providers/${encodeURIComponent(provider.id)}`
        : `/v2/providers/${encodeURIComponent(provider.id)}`;
      await api(target, {
        method: "PUT",
        body: {
          apiKey: apiKey.trim(),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiStyle !== "default" ? { apiStyle } : {}),
        },
      });
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
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {provider.configured ? "Replace" : "Add"} {provider.id} key{scope ? ` (scope: ${scope})` : ""}
            </DialogTitle>
            <DialogDescription>
              Encrypted with AES-256-GCM inside your tenant&apos;s Durable Object and never shown again.
            </DialogDescription>
          </DialogHeader>
          <ErrorAlert error={error} title="The key was not saved" />
          <div className="flex flex-col gap-2">
            <Label htmlFor="provider-api-key">API key</Label>
            <Input
              id="provider-api-key"
              type="password"
              autoComplete="off"
              autoFocus
              value={apiKey}
              onChange={event => setApiKey(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="provider-base-url">Base URL (optional)</Label>
            <Input
              id="provider-base-url"
              placeholder="Default provider endpoint"
              className="font-mono text-xs"
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>API style (optional)</Label>
            <Select value={apiStyle} onValueChange={setApiStyle}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default for provider</SelectItem>
                {API_STYLES.map(style => <SelectItem key={style} value={style}>{style}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!apiKey.trim() || busy}>
              {busy && <Loader2 className="animate-spin" />}Save key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const perMillion = (value: number) => (value ? `$${value.toFixed(2)}` : "—");

export function ModelsPage() {
  const [scopeInput, setScopeInput] = useState("");
  const [activeScope, setActiveScope] = useState("");
  const providersPath = activeScope
    ? `/v2/key-scopes/${encodeURIComponent(activeScope)}/providers`
    : "/v2/providers";
  const modelsPath = activeScope
    ? `/v2/models?keyScope=${encodeURIComponent(activeScope)}`
    : "/v2/models";

  const providersRes = useApi<{ providers: ProviderEntry[] }>(providersPath);
  const modelsRes = useApi<Model[]>(modelsPath);
  const [editing, setEditing] = useState<DisplayProvider>();
  const [error, setError] = useState<string>();

  const rows = useMemo<DisplayProvider[]>(() => {
    const configuredMap = new Map((providersRes.data?.providers ?? []).map(p => [p.provider.toLowerCase(), p]));
    const models = modelsRes.data ?? [];
    const allIds = Array.from(new Set([...KNOWN_PROVIDERS, ...configuredMap.keys()]));
    return allIds.map(id => {
      const matchingModels = models.filter(m => m.provider === id || (id === "google" && m.provider === "gemini"));
      const configured = configuredMap.get(id);
      return {
        id,
        configured,
        platformAvailable: !activeScope && !configured && matchingModels.some(m => m.available),
        modelCount: matchingModels.length,
      };
    });
  }, [providersRes.data, modelsRes.data, activeScope]);

  const reloadAll = () => {
    void providersRes.reload();
    void modelsRes.reload();
  };

  return (
    <>
      <PageHeader
        title="Models & keys"
        docs="models-and-keys"
        description="Configure tenant or scoped BYOK provider keys. Agents use your key when set, or platform-billed models otherwise."
      />
      <ErrorAlert error={providersRes.error ?? modelsRes.error ?? error} />

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Provider keys{activeScope ? ` · scope “${activeScope}”` : ""}</h2>
            <p className="text-muted-foreground text-xs">
              Leave scope empty for tenant-wide keys, or enter a key scope name to manage isolated BYOK keys.
            </p>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault();
              setActiveScope(scopeInput.trim());
            }}
          >
            <Input
              aria-label="Key scope"
              placeholder="Key scope (optional)"
              className="w-48 font-mono text-xs"
              value={scopeInput}
              onChange={event => setScopeInput(event.target.value)}
            />
            <Button size="sm" variant="outline" type="submit">Switch</Button>
            {activeScope && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setScopeInput("");
                  setActiveScope("");
                }}
              >
                Default
              </Button>
            )}
          </form>
        </div>

        {!providersRes.data ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <div className="bg-card border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Models</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Base URL</TableHead>
                  <TableHead className="hidden lg:table-cell">Updated</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(provider => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-mono text-xs font-medium">{provider.id}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{provider.modelCount || "custom"}</TableCell>
                    <TableCell>
                      {provider.configured ? (
                        <Badge><CheckCircle2 />Configured</Badge>
                      ) : provider.platformAvailable ? (
                        <Badge variant="secondary">Platform key</Badge>
                      ) : (
                        <Badge variant="outline">No key</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-48 truncate font-mono text-xs md:table-cell">
                      {provider.configured?.baseUrl ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-xs lg:table-cell">
                      {formatTime(provider.configured?.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="xs" variant="outline" onClick={() => setEditing(provider)}>
                        <KeyRound />{provider.configured ? "Replace" : "Add key"}
                      </Button>
                      {provider.configured && (
                        <span className="ml-2 inline-block">
                          <ConfirmButton
                            size="xs"
                            variant="ghost"
                            label="Remove"
                            title={`Remove ${provider.id} key?`}
                            description="Agents using this provider will fall back to platform keys if available."
                            confirm="Remove key"
                            onConfirm={async () => {
                              try {
                                const delPath = activeScope
                                  ? `/v2/key-scopes/${encodeURIComponent(activeScope)}/providers/${encodeURIComponent(provider.id)}`
                                  : `/v2/providers/${encodeURIComponent(provider.id)}`;
                                await api(delPath, { method: "DELETE" });
                                reloadAll();
                              } catch (caught) {
                                setError((caught as Error).message);
                              }
                            }}
                          />
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <ModelCatalog models={modelsRes.data} loading={modelsRes.loading} />
      {editing && (
        <KeyDialog
          provider={editing}
          scope={activeScope}
          onClose={() => setEditing(undefined)}
          onSaved={reloadAll}
        />
      )}
    </>
  );
}

function ModelCatalog({ models, loading }: { models?: Model[]; loading: boolean }) {
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const providers = useMemo(
    () => Array.from(new Set((models ?? []).map(m => m.provider))).sort(),
    [models],
  );
  const shown = useMemo(
    () =>
      (models ?? []).filter(
        model =>
          (provider === "all" || model.provider === provider) &&
          (!onlyAvailable || model.available) &&
          `${model.id} ${model.provider} ${model.modelId}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [models, provider, onlyAvailable, query],
  );
  const isFiltered = provider !== "all" || onlyAvailable || query.trim().length > 0;
  const visible = isFiltered || showAll ? shown : shown.slice(0, DEFAULT_VISIBLE_MODELS);
  const hiddenCount = shown.length - visible.length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            Models{models ? <span className="text-muted-foreground ml-1.5 font-normal">({shown.length})</span> : null}
          </h2>
          <p className="text-muted-foreground text-xs">
            Pass the ID as <code className="font-mono">model</code> when creating or configuring an agent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              {providers.map(entry => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input className="w-48 pl-7" placeholder="Filter" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <Button variant={onlyAvailable ? "secondary" : "outline"} size="sm" onClick={() => setOnlyAvailable(!onlyAvailable)}>
            Usable only
          </Button>
        </div>
      </div>
      {loading && !models ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="bg-card border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model ID</TableHead>
                <TableHead className="hidden text-right md:table-cell">Max output</TableHead>
                <TableHead className="text-right">Input $/M</TableHead>
                <TableHead className="text-right">Output $/M</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(model => (
                <TableRow key={model.id}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs">{model.id}</span>
                      <CopyButton value={model.id} label="Copy model ID" />
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {model.provider}
                      {model.reasoning ? " · reasoning" : ""}
                      {model.input.includes("image") ? " · images" : ""}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">
                    {model.maxTokens ? formatNumber(model.maxTokens) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{perMillion(model.cost.input)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{perMillion(model.cost.output)}</TableCell>
                  <TableCell className="text-right">
                    {model.available ? <Badge>Usable</Badge> : <Badge variant="outline">Needs key</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">No matching models.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {hiddenCount > 0 && (
            <div className="border-t p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
                Show all {shown.length} models ({hiddenCount} more)
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
