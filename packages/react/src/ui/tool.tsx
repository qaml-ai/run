import { memo, useId, useState, type FormEvent } from "react";
import type { ChatInput, InputAnswer, InputValue, ToolPart } from "@camelai/agent-runtime/chat";
import { useAgent, useToolRendererFor } from "../index.tsx";
import { useUI } from "./context.tsx";

/** A tool's name without its source's prefix (`shop__get_price` is `get_price`). */
const localName = (name: string) => name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
const clip = (text: string, max = 4000) => text.length > max ? `${text.slice(0, max)}…` : text;
const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

/** A tool call: its renderer (generative UI) if it has one, what it waits on, or the default card. */
export const ToolView = memo(function ToolView({ part }: { part: ToolPart }) {
  const ui = useUI();
  const chat = useAgent();
  const exact = useToolRendererFor(part.name, ui.tools);
  const local = useToolRendererFor(localName(part.name), ui.tools);
  const Renderer = exact ?? local;
  if (Renderer) {
    const answer = (value: InputValue | InputAnswer) => part.input ? chat.answer(part.input, value) : Promise.reject(new Error(`${part.name} is not waiting for an answer`));
    return <Renderer part={part} name={part.name} args={part.args} state={part.state} result={part.result} progress={part.progress} input={part.input} answer={answer} />;
  }
  if (part.input) return <ui.components.InputCard input={part.input} />;
  return <ui.components.ToolFallback part={part} />;
});

/** The default card for a tool call: what it was called with, its progress, and its result. */
export function ToolCard({ part }: { part: ToolPart }) {
  const { labels } = useUI();
  const name = localName(part.name);
  const label = part.state === "done" ? labels.toolDone(name) : part.state === "error" ? labels.toolFailed(name) : part.state === "input_required" ? labels.toolWaiting(name) : labels.toolRunning(name);
  const code = typeof part.args.code === "string" ? part.args.code : null;
  const progress = part.progress;
  return (
    <details className="agent-chat__tool" data-state={part.state}>
      <summary>
        <span className="agent-chat__tool-icon" aria-hidden="true" />
        <span className="agent-chat__tool-label">{label}</span>
        {progress?.message && <span className="agent-chat__tool-progress-text">{progress.message}</span>}
      </summary>
      <div className="agent-chat__tool-body">
        {progress?.total ? <progress max={progress.total} value={progress.progress ?? 0} aria-label={label} /> : null}
        <div className="agent-chat__tool-section">
          <div className="agent-chat__tool-heading">{labels.arguments}</div>
          <pre><code>{code ?? pretty(part.args)}</code></pre>
        </div>
        {progress?.text && part.state !== "done" && <pre className="agent-chat__tool-output"><code>{clip(progress.text)}</code></pre>}
        {part.result && (
          <div className="agent-chat__tool-section">
            <div className="agent-chat__tool-heading">{labels.result}</div>
            <pre><code>{clip(part.result.data !== undefined && typeof part.result.data === "object" ? pretty(part.result.data) : part.result.text)}</code></pre>
          </div>
        )}
      </div>
    </details>
  );
}

interface Question { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowOther?: boolean }
interface FieldSchema { type?: string; title?: string; description?: string; enum?: unknown[]; default?: unknown; format?: string }

/** What the agent waits on: an approval, questions, a form, or a page to visit. */
export const InputCard = memo(function InputCard({ input }: { input: ChatInput }) {
  const chat = useAgent();
  const { labels } = useUI();
  const busy = input.answering;
  const answer = (value: InputValue | InputAnswer) => { void chat.answer(input, value); };
  const body = (() => {
    switch (input.kind) {
      case "approval": {
        // The call's arguments, or where they are long, the start of their JSON.
        const shown = input.detail.argumentsPreview ?? (input.detail.arguments ? JSON.stringify(input.detail.arguments, null, 2) : undefined);
        return (
          <>
            <p className="agent-chat__input-message">{input.message}</p>
            {shown && <pre><code>{clip(shown, 2000)}</code></pre>}
            <div className="agent-chat__input-actions">
              <button type="button" className="agent-chat__button agent-chat__button--primary" disabled={busy} onClick={() => answer(true)}>{labels.approve}</button>
              <button type="button" className="agent-chat__button" disabled={busy} onClick={() => answer(false)}>{labels.deny}</button>
            </div>
          </>
        );
      }
      case "question": return <Questions input={input} questions={(input.detail.questions ?? []) as Question[]} onAnswer={answer} />;
      case "form": return <Form input={input} onAnswer={answer} />;
      case "url": {
        const detail = input.detail as { url?: string; origin?: string };
        return (
          <>
            <p className="agent-chat__input-message">{input.message}</p>
            <div className="agent-chat__input-actions">
              {detail.url && /^https:\/\//.test(detail.url) && <a className="agent-chat__button agent-chat__button--primary" href={detail.url} target="_blank" rel="noopener noreferrer">{labels.open}{detail.origin ? ` ${detail.origin}` : ""}</a>}
              <button type="button" className="agent-chat__button" disabled={busy} onClick={() => answer(true)}>{labels.done}</button>
              <button type="button" className="agent-chat__button" disabled={busy} onClick={() => answer(false)}>{labels.cancel}</button>
            </div>
          </>
        );
      }
      default: return <p className="agent-chat__input-message">{(input as ChatInput).message}</p>;
    }
  })();
  return (
    <div className="agent-chat__input" data-kind={input.kind} aria-busy={busy || undefined}>
      {body}
      {input.error && <p className="agent-chat__input-error" role="alert">{input.error.message}</p>}
    </div>
  );
});

function Questions({ input, questions, onAnswer }: { input: ChatInput; questions: Question[]; onAnswer(value: InputValue): void }) {
  const { labels } = useUI();
  const id = useId();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const valueOf = (question: Question): string | string[] | undefined => {
    const own = other[question.question]?.trim();
    const picked = (chosen[question.question] ?? []).filter(label => label !== OTHER);
    if (question.multiSelect) return [...picked, ...own && chosen[question.question]?.includes(OTHER) ? [own] : []];
    if (chosen[question.question]?.[0] === OTHER || !question.options?.length) return own || undefined;
    return picked[0];
  };
  const complete = questions.every(question => { const value = valueOf(question); return Array.isArray(value) ? value.length > 0 : !!value; });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete) return;
    onAnswer(Object.fromEntries(questions.map(question => [question.question, valueOf(question)!])));
  };
  const pick = (question: Question, label: string, checked: boolean) => setChosen(current => {
    const now = current[question.question] ?? [];
    return { ...current, [question.question]: question.multiSelect ? checked ? [...now, label] : now.filter(item => item !== label) : [label] };
  });
  return (
    <form onSubmit={submit} className="agent-chat__questions">
      {questions.map((question, index) => {
        const name = `${id}-${index}`;
        const options = question.options ?? [];
        const otherChosen = chosen[question.question]?.includes(OTHER) || !options.length;
        return (
          <fieldset key={question.question} disabled={input.answering}>
            <legend>{question.header ? <><span className="agent-chat__question-header">{question.header}</span> {question.question}</> : question.question}</legend>
            {options.map(option => (
              <label key={option.label} className="agent-chat__option">
                <input type={question.multiSelect ? "checkbox" : "radio"} name={name} value={option.label}
                  checked={chosen[question.question]?.includes(option.label) ?? false}
                  onChange={event => pick(question, option.label, event.currentTarget.checked)} />
                <span>{option.label}{option.description && <span className="agent-chat__option-description">{option.description}</span>}</span>
              </label>
            ))}
            {question.allowOther !== false && options.length > 0 && (
              <label className="agent-chat__option">
                <input type={question.multiSelect ? "checkbox" : "radio"} name={name} value={OTHER}
                  checked={chosen[question.question]?.includes(OTHER) ?? false}
                  onChange={event => pick(question, OTHER, event.currentTarget.checked)} />
                <span>{labels.other}</span>
              </label>
            )}
            {otherChosen && (question.allowOther !== false || !options.length) && (
              <input type="text" className="agent-chat__text-input" aria-label={options.length ? `${labels.other}: ${question.question}` : question.question}
                value={other[question.question] ?? ""} onChange={event => { const value = event.currentTarget.value; setOther(current => ({ ...current, [question.question]: value })); }} />
            )}
          </fieldset>
        );
      })}
      <div className="agent-chat__input-actions">
        <button type="submit" className="agent-chat__button agent-chat__button--primary" disabled={!complete || input.answering}>{labels.submit}</button>
      </div>
    </form>
  );
}
const OTHER = "\u0000other";

function Form({ input, onAnswer }: { input: ChatInput; onAnswer(value: InputValue | InputAnswer): void }) {
  const { labels } = useUI();
  const id = useId();
  const schema = (input.detail.requestedSchema ?? {}) as { properties?: Record<string, FieldSchema>; required?: string[] };
  const fields = Object.entries(schema.properties ?? {});
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.flatMap(([name, field]) => field.default !== undefined ? [[name, field.default]] : field.type === "boolean" ? [[name, false]] : [])));
  const set = (name: string, value: unknown) => setValues(current => ({ ...current, [name]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const out: Record<string, unknown> = {};
    for (const [name, field] of fields) {
      const value = values[name];
      if (value === undefined || value === "") continue;
      out[name] = field.type === "number" || field.type === "integer" ? Number(value) : value;
    }
    onAnswer(out);
  };
  return (
    <form onSubmit={submit} className="agent-chat__form">
      <p className="agent-chat__input-message">{input.message}</p>
      <fieldset disabled={input.answering}>
        {fields.map(([name, field]) => {
          const fieldId = `${id}-${name}`;
          const required = schema.required?.includes(name);
          const title = field.title ?? name;
          const described = field.description ? `${fieldId}-description` : undefined;
          let control;
          if (field.type === "boolean") control = <input id={fieldId} type="checkbox" checked={!!values[name]} onChange={event => set(name, event.currentTarget.checked)} aria-describedby={described} />;
          else if (field.enum) control = (
            <select id={fieldId} required={required} value={String(values[name] ?? "")} onChange={event => set(name, event.currentTarget.value)} aria-describedby={described}>
              <option value="" disabled>—</option>
              {field.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
            </select>
          );
          else control = <input id={fieldId} className="agent-chat__text-input" required={required} aria-describedby={described}
            type={field.type === "number" || field.type === "integer" ? "number" : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
            step={field.type === "integer" ? 1 : undefined} value={String(values[name] ?? "")} onChange={event => set(name, event.currentTarget.value)} />;
          return (
            <div key={name} className="agent-chat__field">
              <label htmlFor={fieldId}>{title}{required ? " *" : ""}</label>
              {control}
              {field.description && <span id={described} className="agent-chat__field-description">{field.description}</span>}
            </div>
          );
        })}
      </fieldset>
      <div className="agent-chat__input-actions">
        <button type="submit" className="agent-chat__button agent-chat__button--primary" disabled={input.answering}>{labels.submit}</button>
        <button type="button" className="agent-chat__button" disabled={input.answering} onClick={() => onAnswer({ action: "decline" })}>{labels.skip}</button>
      </div>
    </form>
  );
}

