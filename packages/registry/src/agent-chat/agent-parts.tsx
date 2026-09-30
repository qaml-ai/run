"use client";

import { memo, useCallback, useEffect, useState, type FormEvent } from "react";
import { useAgent, useToolRendererFor, type ChatInput, type FilePart, type InputAnswer, type InputValue, type ToolPart, type ToolRenderers } from "@camelai/run-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const localName = (name: string) => name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
const clip = (text: string, max = 4000) => text.length > max ? `${text.slice(0, max)}…` : text;
const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

/** A tool call: your component for it (generative UI), what it waits on, or a collapsible card. */
export const AgentTool = memo(function AgentTool({ part, tools }: { part: ToolPart; tools?: ToolRenderers }) {
  const chat = useAgent();
  const exact = useToolRendererFor(part.name, tools);
  const local = useToolRendererFor(localName(part.name), tools);
  const Renderer = exact ?? local;
  if (Renderer) {
    const answer = (value: InputValue | InputAnswer) => part.input ? chat.answer(part.input, value) : Promise.reject(new Error(`${part.name} is not waiting for an answer`));
    return <Renderer part={part} name={part.name} args={part.args} state={part.state} result={part.result} progress={part.progress} input={part.input} answer={answer} />;
  }
  if (part.input) return <AgentInputCard input={part.input} />;
  const name = localName(part.name);
  const label = part.state === "done" ? `Used ${name}` : part.state === "error" ? `${name} failed` : `Running ${name}…`;
  return (
    <details className="group rounded-md border text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className={cn("size-2 rounded-full", part.state === "done" ? "bg-green-500" : part.state === "error" ? "bg-destructive" : "animate-pulse bg-muted-foreground")} />
        <span>{label}</span>
        {part.progress?.message && <span className="truncate text-xs">{part.progress.message}</span>}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs"><code>{typeof part.args.code === "string" ? part.args.code : pretty(part.args)}</code></pre>
        {part.result && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs"><code>{clip(typeof part.result.data === "object" && part.result.data !== null ? pretty(part.result.data) : part.result.text)}</code></pre>}
      </div>
    </details>
  );
});

interface Question { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowOther?: boolean }

/** What the agent waits on: an approval, questions, a form, or a page to visit. */
export const AgentInputCard = memo(function AgentInputCard({ input }: { input: ChatInput }) {
  const chat = useAgent();
  const answer = (value: InputValue | InputAnswer) => { void chat.answer(input, value); };
  const busy = input.answering;
  return (
    <div className="space-y-3 rounded-lg border p-4 text-sm" aria-busy={busy || undefined}>
      {input.kind === "approval" && (
        <>
          <p className="font-medium">{input.message}</p>
          {(input.detail.argumentsPreview ?? input.detail.arguments) && <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">{clip(input.detail.argumentsPreview ?? JSON.stringify(input.detail.arguments, null, 2), 2000)}</pre>}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => answer(true)}>Approve</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(false)}>Deny</Button>
          </div>
        </>
      )}
      {input.kind === "question" && <Questions questions={(input.detail.questions ?? []) as Question[]} busy={busy} onAnswer={answer} />}
      {input.kind === "form" && <FormFields input={input} busy={busy} onAnswer={answer} />}
      {input.kind === "url" && (
        <>
          <p className="font-medium">{input.message}</p>
          <div className="flex flex-wrap gap-2">
            {typeof input.detail.url === "string" && input.detail.url.startsWith("https://") && (
              <a href={input.detail.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-primary-foreground">Open {String(input.detail.origin ?? "")}</a>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(true)}>Done</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer(false)}>Cancel</Button>
          </div>
        </>
      )}
      {input.error && <p role="alert" className="text-destructive">{input.error.message}</p>}
    </div>
  );
});

function Questions({ questions, busy, onAnswer }: { questions: Question[]; busy: boolean; onAnswer(value: InputValue): void }) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const valueOf = (question: Question) => {
    const own = other[question.question]?.trim();
    const picked = chosen[question.question] ?? [];
    if (question.multiSelect) return own ? [...picked, own] : picked;
    return picked[0] ?? own;
  };
  const complete = questions.every(question => { const value = valueOf(question); return Array.isArray(value) ? value.length > 0 : !!value; });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete) onAnswer(Object.fromEntries(questions.map(question => [question.question, valueOf(question)!])));
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {questions.map(question => (
        <fieldset key={question.question} disabled={busy} className="space-y-2">
          <legend className="mb-2 font-medium">{question.question}</legend>
          {(question.options ?? []).map(option => (
            <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 has-[:checked]:border-primary">
              <input
                type={question.multiSelect ? "checkbox" : "radio"} name={question.question} className="mt-1 accent-primary"
                checked={chosen[question.question]?.includes(option.label) ?? false}
                onChange={event => {
                  const checked = event.currentTarget.checked;
                  setChosen(current => ({ ...current, [question.question]: question.multiSelect ? checked ? [...current[question.question] ?? [], option.label] : (current[question.question] ?? []).filter(label => label !== option.label) : [option.label] }));
                  if (!question.multiSelect) setOther(current => ({ ...current, [question.question]: "" }));
                }} />
              <span>{option.label}{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span>
            </label>
          ))}
          {question.allowOther !== false && (
            <input
              aria-label={`Other answer: ${question.question}`} placeholder={question.options?.length ? "Other…" : "Your answer"}
              className="h-9 w-full rounded-md border bg-transparent px-3" value={other[question.question] ?? ""}
              onChange={event => {
                const value = event.currentTarget.value;
                setOther(current => ({ ...current, [question.question]: value }));
                if (!question.multiSelect && value) setChosen(current => ({ ...current, [question.question]: [] }));
              }} />
          )}
        </fieldset>
      ))}
      <Button type="submit" size="sm" disabled={!complete || busy}>Submit</Button>
    </form>
  );
}

function FormFields({ input, busy, onAnswer }: { input: ChatInput; busy: boolean; onAnswer(value: InputValue | InputAnswer): void }) {
  const schema = (input.detail.requestedSchema ?? {}) as { properties?: Record<string, { type?: string; title?: string; description?: string; enum?: unknown[] }>; required?: string[] };
  const fields = Object.entries(schema.properties ?? {});
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer(Object.fromEntries(fields.flatMap(([name, field]) => {
      const value = values[name];
      if (value === undefined || value === "") return field.type === "boolean" ? [[name, false]] : [];
      return [[name, field.type === "number" || field.type === "integer" ? Number(value) : value]];
    })));
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="font-medium">{input.message}</p>
      {fields.map(([name, field]) => (
        <label key={name} className="block space-y-1">
          <span className="text-sm">{field.title ?? name}{schema.required?.includes(name) ? " *" : ""}</span>
          {field.type === "boolean" ? (
            <input type="checkbox" disabled={busy} checked={values[name] === true} onChange={event => { const checked = event.currentTarget.checked; setValues(current => ({ ...current, [name]: checked })); }} className="ml-2 accent-primary" />
          ) : field.enum ? (
            <select disabled={busy} required={schema.required?.includes(name)} value={String(values[name] ?? "")} onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [name]: value })); }} className="h-9 w-full rounded-md border bg-transparent px-2">
              <option value="" disabled>Choose…</option>
              {field.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
            </select>
          ) : (
            <input disabled={busy} required={schema.required?.includes(name)} type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={String(values[name] ?? "")}
              onChange={event => { const value = event.currentTarget.value; setValues(current => ({ ...current, [name]: value })); }} className="h-9 w-full rounded-md border bg-transparent px-3" />
          )}
          {field.description && <span className="block text-xs text-muted-foreground">{field.description}</span>}
        </label>
      ))}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>Submit</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer({ action: "decline" })}>Skip</Button>
      </div>
    </form>
  );
}

/** A file the agent handed over: an image inline, anything else as a download (a signed link through your handler). */
export const AgentFile = memo(function AgentFile({ part }: { part: FilePart }) {
  const chat = useAgent();
  const [url, setUrl] = useState(part.url);
  const refresh = useCallback(() => { chat.fileUrl(part.path).then(setUrl, () => {}); }, [chat, part.path]);
  useEffect(() => { if (part.url) setUrl(part.url); else refresh(); }, [part.url, refresh]);
  const image = part.contentType?.startsWith("image/") && part.contentType !== "image/svg+xml";
  return (
    <figure className="max-w-sm space-y-1">
      {image && url && <img src={url} alt={part.caption ?? part.name} className="max-h-80 rounded-md border" loading="lazy" />}
      <a href={url} download={part.name} target="_blank" rel="noopener noreferrer" onMouseEnter={refresh} onFocus={refresh}
        className="flex flex-col rounded-md border px-3 py-2 text-sm hover:bg-muted">
        <span className="font-medium">{part.name}</span>
        <span className="text-xs text-muted-foreground">{part.caption ?? "Download"}</span>
      </a>
    </figure>
  );
});
