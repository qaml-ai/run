// Generated from src/agent-mcp.ts by scripts/reuse-agent-mcp.mjs. Only host dependencies change.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Api, ApiError, summarize, type RunSummary } from './agent-mcp-api.ts';
import { digest } from './api-contract.ts';
import { followEvents as follow } from './event-follow.ts';
const resumeId = async (id: string) => 'resume_' + (await digest(id)).slice(0, 40);

/** An input as GET .../inputs lists it. */
interface Input { id: string; requestId: string; kind: "question" | "approval" | "form" | "url"; message: string; detail: Record<string, any> }
type Item = { kind: "event"; data: any } | { kind: "reply"; input: Input; message: any } | { kind: "reconnected" } | { kind: "failed"; error: Error } | { kind: "aborted" };
export type Extra = { requestId: string | number; signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification(notification: any): Promise<void> };
export interface Call {
  fetch: typeof fetch;
  agent: string; api: Api; own: boolean; authorization: string; events: string; publicUrl: string;
  /** What the client can ask a person with. */
  form: boolean; url: boolean;
  /** Sends an elicitation on the call's stream. */
  elicit(id: string, params: Record<string, unknown>, extra: Extra): Promise<void>;
  waiting: Map<string, { agent: string; reply: (message: any) => void }>;
}

/** An elicitation's JSON-RPC id: this prefix and the input it asks for. */
const ELICIT = "input:";
/** A progress notification at least this often, so clients that time out without one keep waiting. */
const HEARTBEAT_MS = 20_000;
/** Streaming text is reported at most this often. */
const TEXT_EVERY_MS = 1_000;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const text = (value: string, isError = false, structuredContent?: Record<string, unknown>): CallToolResult =>
  ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}), ...(structuredContent ? { structuredContent } : {}) });

/** The tool's description: the agent's name, and what it is for when its definition says. */
export function describe(name: string | undefined, description: string | undefined) {
  return [
    `Send a message to the agent ${name ? `"${name}"` : "this endpoint serves"} and get its reply.`,
    ...(description ? [description] : []),
    "It keeps one conversation with everyone who messages it, so it remembers what was said before. A reply can take minutes.",
  ].join("\n\n");
}

/** Send the message (once) and follow its turn to the reply: through any inputs it waits on, and the runs that resume it. */
export async function converse(call: Call, message: string, requestId: string, extra: Extra): Promise<CallToolResult> {
  const { api } = call;
  const inbox = new Inbox();
  const stop = new AbortController();
  const abort = () => { stop.abort(); inbox.push({ kind: "aborted" }); };
  if (extra.signal.aborted) abort(); else extra.signal.addEventListener("abort", abort, { once: true });
  const progress = reporter(extra);
  const asked = new Map<string, Input>();
  try {
    // The stream is open before the message is sent, so nothing its turn publishes is missed.
    await follow(call, inbox, stop.signal);
    if (stop.signal.aborted) return text("The call was cancelled before the message was sent", true);
    let current = requestId;
    let record: any;
    try {
      record = call.own ? await api.call("POST", "/requests", { id: requestId, method: "prompt", params: { text: message } })
        : await api.call("POST", "/prompt", { text: message, requestId });
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) return text(`The agent is busy: ${error.message}. Try again once it has worked through them.`, true);
      throw error;
    }
    const get = (id: string) => api.get(`/requests/${id}`).catch(error => { if (error instanceof ApiError && error.status === 404) return undefined; throw error; });
    for (;;) {
      if (record?.state === "completed") {
        const run = summarize(call.agent, record);
        if (run.status !== "input_required") return finished(run);
        // Waiting on people: ask them, one input at a time, until none of the turn's is pending; then follow the run resuming it.
        const pending = (await api.get<Input[]>("/inputs?state=pending")).filter(input => input.requestId === current).reverse();
        if (!pending.length) { current = await resumeId(current); record = await get(current); continue; }
        if (!pending.some(input => asked.has(input.id))) {
          const params = elicitation(pending[0], call);
          if (!params) return inputRequired(call, requestId, pending);
          const elicitId = `${ELICIT}${pending[0].id}`;
          asked.set(pending[0].id, pending[0]);
          call.waiting.set(elicitId, { agent: call.agent, reply: reply => inbox.push({ kind: "reply", input: pending[0], message: reply }) });
          progress.send(`Asking you: ${pending[0].message}`);
          await call.elicit(elicitId, params, extra);
        }
        record = undefined;
      }
      const item = await inbox.next();
      if (item.kind === "aborted") return text("The call was cancelled; the agent's turn goes on", true);
      if (item.kind === "failed") throw item.error;
      if (item.kind === "reconnected") { record = await get(current); continue; }
      if (item.kind === "reply") {
        if (!await settle(api, item.input, item.message)) return inputRequired(call, requestId, (await api.get<Input[]>("/inputs?state=pending")).filter(input => input.requestId === current).reverse());
        record = await get(current);
        continue;
      }
      const data = item.data;
      if (data.type === "response" && data.id === current) record = { id: current, state: "completed", outcome: data.outcome };
      else if (data.type === "event" && data.requestId === current) {
        if (data.event.type === "input_resolved" && data.event.state === "superseded") return text("A newer message to the agent set aside the input this turn waited on: the agent answers that message instead.", true);
        if (data.event.type === "input_resolved") record = await get(current);
        else progress.event(data.event);
      }
    }
  } catch (error) {
    return text((error as Error).message, true);
  } finally {
    stop.abort();
    progress.stop();
    for (const id of asked.keys()) call.waiting.delete(`${ELICIT}${id}`);
  }
}

/** A run's end as the tool's result: the reply, or the runtime's (or the model's) error. */
function finished(run: RunSummary): CallToolResult {
  if (run.status === "failed") return text(run.error!.message, true, { requestId: run.requestId, error: run.error });
  return text(run.text || "(The agent ended its turn without a reply.)", false, { requestId: run.requestId });
}

/** Inputs this client cannot ask for: what they are, and how to answer. */
function inputRequired(call: Call, requestId: string, inputs: Input[]): CallToolResult {
  const lines = inputs.map(input => {
    const detail = input.detail ?? {};
    const what = input.kind === "question" ? detail.questions.map((q: any) => `${q.question} (${q.options.map((option: any) => option.label).join(", ")}${q.allowOther ? ", or your own words" : ""})`).join("; ")
      : input.kind === "approval" ? `${input.message} ${clip(JSON.stringify(detail.arguments ?? detail.argumentsPreview ?? {}), 1000)}`
      : input.kind === "url" ? `${input.message} Open ${detail.url}, then confirm it is done.`
      : `${input.message} (fields: ${Object.keys(detail.requestedSchema?.properties ?? {}).join(", ")})`;
    return `- ${input.kind} ${input.id}: ${what}`;
  });
  const agentUrl = `${call.publicUrl}/v1/agents/${call.agent}`;
  return text([
    "The agent is waiting for a person's input before it goes on:",
    ...lines,
    `Answer in the camelRun console, or with POST ${agentUrl}/inputs/<input id> ({"action": "accept" or "decline", "content": …}; see ${call.publicUrl}/docs/guides/human-input.md). Once every input is answered the turn resumes: call message again with the same text and requestId "${requestId}" for its reply.`,
    "Or send a new message instead: it sets these inputs aside, and the agent reads your message.",
  ].join("\n"), false, { status: "input_required", requestId, inputs: inputs.map(({ id, kind, message, detail }) => ({ id, kind, message, detail })) });
}

/** The elicitation that asks for `input`, or none when this client cannot show it. */
function elicitation(input: Input, can: { form: boolean; url: boolean }): Record<string, unknown> | undefined {
  const detail = input.detail ?? {};
  const none = { type: "object", properties: {} };
  if (input.kind === "url" && can.url) return { mode: "url", message: input.message || "Open this page to go on", url: detail.url, elicitationId: input.id };
  if (!can.form) return undefined;
  if (input.kind === "url") return { message: `${input.message}\n\nOpen ${detail.url}, then accept once it is done.`, requestedSchema: none };
  if (input.kind === "approval") return { message: `${input.message}\n\n${clip(JSON.stringify(detail.arguments ?? detail.argumentsPreview ?? {}), 2000)}`, requestedSchema: none };
  if (input.kind === "form") return { message: input.message, requestedSchema: detail.requestedSchema };
  const questions: { question: string; header: string; options: { label: string }[]; multiSelect: boolean; allowOther: boolean }[] = detail.questions;
  const field = (q: typeof questions[number]) => {
    const labels = q.options.map(option => option.label);
    const described = { title: q.header, description: q.allowOther ? `${q.question} (${labels.join(", ")}, or your own words)` : q.question };
    const choice = q.allowOther ? { type: "string" } : { type: "string", enum: labels };
    return q.multiSelect ? { type: "array", ...described, items: choice } : { ...choice, ...described };
  };
  return { message: input.message, requestedSchema: { type: "object", properties: Object.fromEntries(questions.map((q, index) => [`q${index + 1}`, field(q)])), required: questions.map((_, index) => `q${index + 1}`) } };
}

/** Answer `input` with the person's reply to its elicitation. False when they did not answer (dismissed it, or the client could not ask). */
export async function settle(api: Api, input: Input, reply: any): Promise<boolean> {
  const action = reply.result?.action;
  if (reply.error || (action !== "accept" && action !== "decline")) return false;
  const content = reply.result.content ?? {};
  const answer = action === "decline" ? { action } : input.kind === "form" ? { action, content }
    : input.kind === "question" ? { action, content: { answers: Object.fromEntries(input.detail.questions.map((q: { question: string }, index: number) => [q.question, content[`q${index + 1}`]])) } }
    : { action };
  // Settled otherwise meanwhile (answered elsewhere, expired): the turn goes on either way.
  await api.call("POST", `/inputs/${encodeURIComponent(input.id)}`, answer).catch(error => { if (!(error instanceof ApiError && error.status === 409)) throw error; });
  return true;
}

/** Progress notifications for the call, when it asked for them: streaming text now and then, each tool used, and a heartbeat. */
function reporter(extra: Extra) {
  const token = extra._meta?.progressToken;
  let count = 0, last = 0, lastText = 0, said = "";
  const send = (message: string) => {
    if (token === undefined) return;
    last = Date.now();
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++count, message } }).catch(() => {});
  };
  const heartbeat = token === undefined ? undefined : setInterval(() => { if (Date.now() - last >= HEARTBEAT_MS) send("Working…"); }, HEARTBEAT_MS);
  return {
    send,
    event(event: any) {
      if (event.type === "message_start") said = "";
      else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        said = (said + event.assistantMessageEvent.delta).slice(-200);
        if (Date.now() - lastText >= TEXT_EVERY_MS) { lastText = Date.now(); send(said); }
      } else if (event.type === "tool_execution_start") send(`Using ${event.toolName}`);
      else if (event.type === "compaction_start") send("Compacting its history");
    },
    stop() { clearInterval(heartbeat); },
  };
}

/** What a call waits on, in the order it arrived. */
class Inbox {
  private readonly items: Item[] = [];
  private wake?: () => void;
  push(item: Item) { this.items.push(item); this.wake?.(); }
  async next(): Promise<Item> {
    while (!this.items.length) await new Promise<void>(resolve => { this.wake = resolve; });
    return this.items.shift()!;
  }
}
