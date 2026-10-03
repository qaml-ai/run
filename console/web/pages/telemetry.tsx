import { useState, type FormEvent } from "react";
import { Loader2, Plus, Send, ShieldAlert, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton, CopyButton, ErrorAlert, PageHeader } from "@/components/common";
import { api, formatTime, useApi, type Me, type Telemetry, type TelemetryProtocol, type TelemetryTest } from "@/lib/api";

/** Where common backends take OTLP traces, and the headers they check (docs/guides/observability.md, Presets). */
export const PRESETS: { id: string; label: string; endpoint: string; headers: { name: string; hint: string }[]; note: string }[] = [
  {
    id: "langsmith", label: "LangSmith", endpoint: "https://api.smith.langchain.com/otel/v1/traces",
    headers: [{ name: "x-api-key", hint: "LangSmith API key" }, { name: "Langsmith-Project", hint: "Project name" }],
    note: "EU: https://eu.api.smith.langchain.com/otel/v1/traces. LangSmith shows model and tool calls as runs; include content to see messages.",
  },
  {
    id: "langfuse", label: "Langfuse", endpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
    headers: [{ name: "Authorization", hint: "Basic <base64 of public-key:secret-key>" }],
    note: "US: https://us.cloud.langfuse.com/api/public/otel/v1/traces. Self-hosted Langfuse: your host, same path.",
  },
  {
    id: "honeycomb", label: "Honeycomb", endpoint: "https://api.honeycomb.io/v1/traces",
    headers: [{ name: "x-honeycomb-team", hint: "Honeycomb API key" }],
    note: "EU: https://api.eu1.honeycomb.io/v1/traces. Traces land in the camelrun dataset.",
  },
  {
    id: "datadog", label: "Datadog", endpoint: "https://otlp.datadoghq.com/v1/traces",
    headers: [{ name: "dd-api-key", hint: "Datadog API key" }],
    note: "Use your site's host (e.g. otlp.datadoghq.eu). Add a dd-otlp-source header set to llmobs for LLM Observability instead of APM.",
  },
  {
    id: "grafana", label: "Grafana Cloud", endpoint: "https://otlp-gateway-<zone>.grafana.net/otlp/v1/traces",
    headers: [{ name: "Authorization", hint: "Basic <base64 of instance-id:token>" }],
    note: "Replace <zone> with your stack's zone. Self-managed Tempo: its OTLP/HTTP receiver, port 4318.",
  },
  {
    id: "custom", label: "Custom collector", endpoint: "",
    headers: [],
    note: "Any OTLP/HTTP endpoint on the public internet, over HTTPS. A collector's base URL gets /v1/traces.",
  },
];

type Row = { key: number; name: string; value: string; hint?: string };
let nextKey = 0;
const row = (name = "", hint?: string): Row => ({ key: nextKey++, name, value: "", hint });
const origin = (url: string) => { try { return new URL(url).origin; } catch { return undefined; } };

/** The headers to send, or an error naming what is missing. Blank rows are skipped. */
export function headersFrom(rows: Pick<Row, "name" | "value">[]): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const { name: raw, value } of rows) {
    const name = raw.trim();
    if (!name && !value) continue;
    if (!name) return { error: "Name each header, or remove the row." };
    if (!value) return { error: `Enter a value for ${name}, or remove it.` };
    if (seen.has(name.toLowerCase())) return { error: `${name} is listed twice.` };
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  return { headers };
}

export function TelemetryPage({ me }: { me: Pick<Me, "canStoreKeys"> }) {
  const settings = useApi<Telemetry>("/v1/telemetry");
  const none = settings.error?.status === 404;
  const unavailable = settings.error?.status === 503;
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TelemetryTest>();
  const current = none ? undefined : settings.data;

  async function sendTest() {
    setTesting(true); setError(undefined); setTest(undefined);
    try { setTest(await api<TelemetryTest>("/v1/telemetry/test", { body: {} })); await settings.reload(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setTesting(false); }
  }
  async function remove() {
    setError(undefined); setTest(undefined); setSaved(false);
    try { await api("/v1/telemetry", { method: "DELETE" }); await settings.reload(); }
    catch (caught) { setError((caught as Error).message); }
  }

  return (
    <>
      <PageHeader title="Telemetry" description="Export your agents' runs as OpenTelemetry traces to your own backend: LangSmith, Langfuse, Honeycomb, Datadog, Grafana or any OTLP/HTTP collector."
        actions={current && <>
          <Button size="sm" variant="outline" onClick={() => void sendTest()} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <Send />}Send test span</Button>
          <ConfirmButton label="Remove" icon={<Trash2 />} title="Stop exporting traces?" confirm="Remove telemetry"
            description="The endpoint, its settings and the stored headers are deleted. Runs are no longer exported." onConfirm={remove} />
        </>} />
      <ErrorAlert error={error ?? (none ? undefined : settings.error)} />
      {test && <TestResult test={test} />}
      {saved && !error && <p role="status" className="text-muted-foreground mb-4 text-sm">Saved. Send a test span to check the endpoint and its headers.</p>}
      {unavailable ? null : settings.loading && !settings.data && !settings.error ? <Skeleton className="h-96 w-full" /> : <>
        {current && <Status telemetry={current} />}
        <TelemetryForm key={current?.updatedAt ?? "none"} current={current} canStoreKeys={me.canStoreKeys}
          onSaved={async () => { setTest(undefined); setSaved(true); await settings.reload(); }} />
      </>}
    </>
  );
}

function Status({ telemetry }: { telemetry: Telemetry }) {
  const { lastExportAt, lastError, lastErrorAt } = telemetry.status;
  return (
    <section className="bg-card mb-6 border p-5" aria-label="Export status">
      <h2 className="text-base font-semibold">Status</h2>
      <dl className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground text-xs">Last export</dt>
          <dd className="mt-1">{lastExportAt ? formatTime(lastExportAt) : "No spans exported yet"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Last error</dt>
          <dd className="mt-1">{lastError
            ? <><span className="text-destructive font-mono text-xs break-words">{lastError}</span>{lastErrorAt && <span className="text-muted-foreground"> · {formatTime(lastErrorAt)}</span>}</>
            : "None since the last successful export"}</dd>
        </div>
      </dl>
    </section>
  );
}

function TestResult({ test }: { test: TelemetryTest }) {
  const answered = test.status !== undefined ? `HTTP ${test.status}` : undefined;
  return (
    <Alert variant={test.ok ? "default" : "destructive"} className="mb-4">
      <AlertTitle>{test.ok ? `The endpoint accepted the test span${answered ? ` (${answered})` : ""}` : "The test span was not accepted"}</AlertTitle>
      <AlertDescription>
        {!test.ok && <p>{[answered, test.error].filter(Boolean).join(": ") || "No answer"}</p>}
        <div className="flex flex-wrap items-center gap-1">
          <span>Trace ID</span><code className="text-foreground font-mono text-xs">{test.traceId}</code><CopyButton value={test.traceId} label="Copy trace ID" />
        </div>
        {test.ok && <p>Look for the span “camelrun test span” in your backend.</p>}
      </AlertDescription>
    </Alert>
  );
}

function TelemetryForm({ current, canStoreKeys, onSaved }: { current?: Telemetry; canStoreKeys: boolean; onSaved: () => Promise<void> }) {
  const stored = current?.headers ?? [];
  const [preset, setPreset] = useState<string>();
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [protocol, setProtocol] = useState<TelemetryProtocol>(current?.protocol ?? "http/protobuf");
  const [percent, setPercent] = useState(String(Math.round((current?.sampleRate ?? 1) * 10_000) / 100));
  const [content, setContent] = useState(current?.include.content ?? false);
  // Stored header values are never returned: they are kept as they are, or every header is entered again.
  const [editing, setEditing] = useState(!stored.length);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const presetNote = PRESETS.find(entry => entry.id === preset)?.note;
  const moved = !editing && stored.length > 0 && origin(endpoint) !== origin(current!.endpoint);

  function choosePreset(id: string) {
    const chosen = PRESETS.find(entry => entry.id === id)!;
    setPreset(id);
    setEndpoint(chosen.endpoint);
    setEditing(true);
    setRows(chosen.headers.map(header => row(header.name, header.hint)));
  }
  function editStored(remove?: string) {
    setEditing(true);
    setRows(stored.filter(name => name !== remove).map(name => row(name)));
  }
  const update = (key: number, change: Partial<Row>) => setRows(list => list.map(entry => entry.key === key ? { ...entry, ...change } : entry));

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const rate = Number(percent);
    if (percent.trim() === "" || !Number.isFinite(rate) || rate < 0 || rate > 100) { setError("Enter a share of runs from 0 to 100%."); return; }
    let headers: Record<string, string> | undefined;
    if (canStoreKeys && editing) {
      const parsed = headersFrom(rows);
      if ("error" in parsed) { setError(parsed.error); return; }
      headers = parsed.headers;
    }
    setBusy(true);
    try {
      await api<Telemetry>("/v1/telemetry", { method: "PUT", body: { endpoint: endpoint.trim(), protocol, sampleRate: rate / 100, include: { content }, ...(headers ? { headers } : {}) } });
      setRows(list => list.map(entry => ({ ...entry, value: "" })));
      await onSaved();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="bg-card flex flex-col gap-5 border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{current ? "Settings" : "Set up export"}</h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">Each run becomes a trace, with a span for every model call, tool call and compaction, following the OpenTelemetry GenAI conventions.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="telemetry-preset">Preset</Label>
          <Select value={preset ?? ""} onValueChange={choosePreset}>
            <SelectTrigger id="telemetry-preset" aria-label="Preset" className="w-44"><SelectValue placeholder="Choose a backend" /></SelectTrigger>
            <SelectContent>{PRESETS.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <ErrorAlert error={error} className="mb-0" />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="telemetry-endpoint">Endpoint</Label>
        <Input id="telemetry-endpoint" className="font-mono" placeholder="https://otel.example.com:4318/v1/traces" autoComplete="off" value={endpoint} onChange={event => setEndpoint(event.target.value)} />
        <p className="text-muted-foreground text-xs">{presetNote ?? "The OTLP/HTTP traces URL, over HTTPS. A collector's base URL gets /v1/traces."}</p>
      </div>

      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="telemetry-protocol">Protocol</Label>
          <Select value={protocol} onValueChange={value => setProtocol(value as TelemetryProtocol)}>
            <SelectTrigger id="telemetry-protocol" aria-label="Protocol" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="http/protobuf">http/protobuf</SelectItem>
              <SelectItem value="http/json">http/json</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="telemetry-sample">Runs traced (%)</Label>
          <Input id="telemetry-sample" type="number" min={0} max={100} step="any" className="w-28 font-mono" value={percent} onChange={event => setPercent(event.target.value)} />
        </div>
      </div>
      <p className="text-muted-foreground -mt-3 text-xs">A run that continues your own trace follows its traceparent's sampled flag instead.</p>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={content} onChange={event => setContent(event.target.checked)} />
          Include content (prompts, replies, tool arguments and results)
        </label>
        <p className="text-muted-foreground flex max-w-2xl gap-1.5 text-xs">
          <ShieldAlert className="mt-px size-3.5 shrink-0" />
          <span>Off by default. Without it, spans carry ids, names, models, token counts, costs, durations and outcomes, but nothing your users or the models wrote.
            Turn it on for development, or where your backend is allowed to keep your users' data. Content goes only to your endpoint.</span>
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Headers</Label>
        {!canStoreKeys ? (
          <p className="text-muted-foreground text-xs">This runtime has no secret encryption configured (AGENT_SECRETS_KEY), so it cannot keep headers. Ask an admin to set it.</p>
        ) : !editing ? <>
          <p className="text-muted-foreground text-xs">Stored encrypted. Their values are never shown again.</p>
          <ul className="divide-y border" aria-label="Stored headers">
            {stored.map(name => (
              <li key={name} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="min-w-40 font-mono text-xs">{name}</span>
                <span className="text-muted-foreground flex-1 font-mono text-xs" aria-label={`${name} value hidden`}>••••••••</span>
                <Button type="button" size="xs" variant="outline" onClick={() => editStored()}>Replace</Button>
                <Button type="button" size="xs" variant="ghost" aria-label={`Remove ${name}`} onClick={() => editStored(name)}><X /></Button>
              </li>
            ))}
          </ul>
          {moved && <p className="text-destructive text-xs">This endpoint is on a different origin: the stored headers are dropped when you save. Replace them to send them there.</p>}
        </> : <>
          <p className="text-muted-foreground text-xs">{stored.length
            ? "Saving replaces every stored header, and their values are never shown, so enter the value of each header you keep."
            : "Sent with every export, such as your backend's API key. Stored encrypted and never shown again."}</p>
          {rows.map(entry => (
            <div key={entry.key} className="flex flex-wrap items-center gap-2">
              <Input aria-label="Header name" placeholder="Name" className="w-48 font-mono" autoComplete="off" value={entry.name} onChange={event => update(entry.key, { name: event.target.value })} />
              <Input aria-label={`Value for ${entry.name || "header"}`} type="password" placeholder={entry.hint ?? "Value"} className="min-w-48 flex-1 font-mono" autoComplete="new-password"
                value={entry.value} onChange={event => update(entry.key, { value: event.target.value })} />
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${entry.name || "header"}`} onClick={() => setRows(list => list.filter(other => other.key !== entry.key))}><X /></Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="xs" variant="outline" onClick={() => setRows(list => [...list, row()])}><Plus />Add header</Button>
            {stored.length > 0 && <Button type="button" size="xs" variant="ghost" onClick={() => { setEditing(false); setRows([]); }}>Keep stored headers</Button>}
          </div>
          {stored.length > 0 && rows.every(entry => !entry.name.trim()) && <p className="text-destructive text-xs">Saving now removes every stored header.</p>}
        </>}
      </div>

      <div><Button type="submit" size="sm" disabled={!endpoint.trim() || busy}>{busy && <Loader2 className="animate-spin" />}{current ? "Save" : "Start exporting"}</Button></div>
    </form>
  );
}
