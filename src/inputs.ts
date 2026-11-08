import { createHash, randomBytes } from "node:crypto";
import type { Sealed } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { underClaim, type Claim } from "./ownership.ts";
import { canonical } from "../shared/durable-json.ts";
import { schemaAccepts } from "./tool-policy.ts";
import type { Sender } from "./sender.ts";
import { enqueueEvents, webhookEvent, type WebhookEvent } from "./webhooks.ts";

/**
 * Human input: a question the model asks (ask_user), an approval the runtime's policy or a tool asks
 * for, or a form or URL step a tool asks for (MCP's `input_required`). A tool call that needs one
 * does not finish: the turn suspends with the call open (agent-host.ts), and the input waits here,
 * a row in `agent_inputs`, for as long as it takes. Answers are compare-and-set from pending, so each
 * input settles once. When the last input of a suspension settles, a `resume` run gives each open
 * call its result: the answer itself, or the call run again with it (`RetryPlan`).
 */
export type InputKind = "question" | "approval" | "form" | "url" | "decision";
export type InputState = "pending" | "answered" | "declined" | "cancelled" | "expired" | "superseded" | "withdrawn";
/** Where an item sits in a person's queue (agent_inputs.priority): an approval is `high`, everything else `normal`. */
export type Priority = "urgent" | "high" | "normal" | "low";
export type Action = "accept" | "decline" | "cancel";
/** Who answered: the application (its token, and whom it names), a channel's sender, or the runtime itself. */
export type Responder = { via?: "api" | "agent" | "channel"; from?: Sender; actor?: string; system?: "expired" | "aborted" | "superseded" };
export type Answer = { action: Action; content?: unknown; by: Responder; at: number };
export interface Input {
  id: string; agent: string; tenant: string; requestId: string; toolCallId: string;
  kind: InputKind; message: string;
  priority?: Priority; blocking?: boolean; key?: string; version?: number;
  attachments?: { path: string; version: number; contentType?: string; caption?: string }[];
  links?: string[]; recommendation?: { answer: unknown; reason: string }; applyRecommendationOnExpiry?: boolean;
  /** question: { questions }; approval: { tool, source, arguments (or argumentsPreview), argumentsHash, reason? }; form: { requestedSchema }; url: { url, origin }. */
  detail: Record<string, any>;
  /** Who may answer, besides the definition's approvers: the person whose message started the turn. */
  responders: { audience?: string[] };
  state: InputState; answer?: Answer; createdAt: number; expiresAt: number;
}
/** What is stored beyond what callers see: how the call is retried once answered. */
type Stored = Pick<Input, "message" | "detail" | "responders"> & {
  /** The call's name and a hash of its arguments: a retry must be the same call. */
  tool: string; argumentsHash: string;
  delivery?: { id: string; inputs: string[] };
  /** The tool's own request's key (MCP `inputRequests`), answered by the same key on the retry. */
  key?: string;
  /** The tool's opaque `requestState`, sealed at rest; never shown to the model or callers. */
  requestState?: Sealed | string;
};
export type InputRow = Input & { stored: Stored };
/** How a call is run again once its inputs are answered: with the approval's proof, and the tool's requests' answers. */
export type RetryPlan = { argumentsHash: string; approval?: { input: string; by: Responder; at: number }; inputResponses?: Record<string, unknown>; requestState?: string; note: string };
export type HumanInputSettings = { expiresInSeconds?: number; approvers?: string[] };
/**
 * The channel an item's change is announced on (`pg_notify`, the tenant as payload), in the transaction that writes it:
 * a node's inbox watchers (`GET /v1/inbox/events`) re-read what changed. Heard by every node; the tenant says whose it was.
 */
export const INBOX_CHANNEL = "inbox";
type Sealer = { seal(aad: string, plaintext: string): Sealed; unseal(aad: string, sealed: Sealed): string };

/**
 * How long inputs wait by default: 15 minutes. Then the runtime answers for the person (`timedOut`) and the turn goes on.
 * Long enough for someone who stepped away briefly; short enough that a turn left
 * waiting does not hold its agent (on Workers, a call waiting on a person keeps the agent's Durable Object in memory).
 */
export const INPUT_LIMITS = Object.freeze({ defaultExpiresSeconds: 15 * 60, maxExpiresSeconds: 30 * 86_400, perCall: 8, text: 4_000, arguments: 4_000 });
const FINAL: Record<Action, InputState> = { accept: "answered", decline: "declined", cancel: "cancelled" };
/** The priority a kind of input gets unless its asker names one: an approval is high, a question, form or url step normal. */
const priorityOf = (kind: InputKind): Priority => kind === "approval" ? "high" : "normal";
/**
 * The queue order of each priority, for the index (`agent_inputs.priority_rank`): urgent first. The priority text sorts
 * alphabetically (high, low, normal, urgent), so the rank is what a page is ordered by, and the migration's check keeps
 * the two in step.
 */
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const argumentsHash = (name: string, args: unknown) => createHash("sha256").update(canonical({ name, arguments: args })).digest("hex");
const clip = (text: unknown, max: number = INPUT_LIMITS.text) => String(text ?? "").slice(0, max);

/** Shared fields for a question or an independent decision. */
export const inboxFields = {
  priority: { type: "string", enum: ["urgent", "high", "normal", "low"], description: "How soon a person should look: urgent, high, normal or low." },
  attachments: { type: "array", maxItems: 32, items: { type: "object", required: ["path"], properties: { path: { type: "string" }, caption: { type: "string" } }, additionalProperties: false } },
  links: { type: "array", maxItems: 32, items: { type: "string" } },
  recommendation: { type: "object", required: ["answer", "reason"], properties: { answer: {}, reason: { type: "string", description: "Why you recommend it, in a sentence." } }, additionalProperties: false },
  applyRecommendationOnExpiry: { type: "boolean", description: "Apply your recommendation if nobody answers before it expires. Never for approvals." },
};
export function inboxDetail(args: Record<string, any>, kind: InputKind = "question") {
  if (args.priority !== undefined && !["urgent", "high", "normal", "low"].includes(args.priority)) throw new Error("Invalid priority");
  if (args.links !== undefined && (!Array.isArray(args.links) || args.links.length > 32 || args.links.some((link: unknown) => { try { return typeof link !== "string" || new URL(link).protocol !== "https:"; } catch { return true; } }))) throw new Error("Use at most 32 https links");
  if (args.attachments !== undefined && (!Array.isArray(args.attachments) || args.attachments.length > 32 || args.attachments.some((file: any) => typeof file?.path !== "string" || !file.path || (file.caption !== undefined && (typeof file.caption !== "string" || file.caption.length > 1000))))) throw new Error("Use at most 32 attachments with paths");
  const questions = questionsInput(args.questions);
  const recommended = Object.fromEntries(questions.filter(q => q.recommended !== undefined).map(q => [q.question, q.recommended]));
  const recommendation = args.recommendation ?? (Object.keys(recommended).length === questions.length ? { answer: { answers: recommended }, reason: questions.map(q => q.reason).join("\n") } : undefined);
  if (recommendation && (typeof recommendation.reason !== "string" || !recommendation.reason.trim())) throw new Error("A recommendation needs a reason");
  if (recommendation) answerInput({ kind, detail: { questions } }, { action: "accept", content: recommendation.answer });
  if (args.applyRecommendationOnExpiry !== undefined && typeof args.applyRecommendationOnExpiry !== "boolean") throw new Error("applyRecommendationOnExpiry must be a boolean");
  if (args.applyRecommendationOnExpiry && (kind === "approval" || !recommendation)) throw new Error("Only questions with a recommendation can apply it on expiry");
  return { questions, ...(args.priority ? { priority: args.priority } : {}), ...(args.attachments ? { attachments: args.attachments } : {}), ...(args.links ? { links: args.links } : {}), ...(recommendation ? { recommendation } : {}), ...(args.applyRecommendationOnExpiry ? { applyRecommendationOnExpiry: true } : {}) };
}
export function decisionDetail(args: Record<string, any>) {
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 1000 || typeof args.body !== "string" || args.body.length > 4000) throw new Error("A decision needs a title and body");
  if (args.key !== undefined && (typeof args.key !== "string" || !args.key.trim() || args.key.length > 200)) throw new Error("A decision key is 1 to 200 characters");
  const recommendation = args.recommendation && typeof args.recommendation.answer === "string"
    ? { ...args.recommendation, answer: { answers: { [args.title]: args.recommendation.answer } } } : args.recommendation;
  return { ...inboxDetail({ ...args, recommendation, questions: [{ question: args.title, options: args.options, allowOther: true }] }), title: args.title, body: args.body };
}
export function expiryAnswer(input: Pick<Input, "kind" | "detail">, now = Date.now()): Answer {
  const automatic = input.kind !== "approval" && input.detail.applyRecommendationOnExpiry === true && input.detail.recommendation;
  return { ...(automatic ? answerInput(input, { action: "accept", content: automatic.answer }) : { action: "cancel" as const }), by: { system: "expired" }, at: now };
}
export function decisionNotice(inputs: InputRow[]) {
  const sorted = [...inputs].sort((a, b) => a.id.localeCompare(b.id));
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return sorted.map(input => `<decision_answer id="${escape(input.id)}" by="${escape(responderName(input.answer!.by))}">${escape(JSON.stringify({ state: input.state, ...input.answer }))}</decision_answer>`).join("\n");
}

/** A person's name for the model, from an answer: never a credential. */
export function responderName(by: Responder) {
  if (by.system) return "the runtime";
  return by.from?.name || by.from?.username || by.from?.id || by.actor || "the application";
}

/** How long an input waited, for the model: "2d 3h", "5m", "40s". */
export function waited(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000)), d = Math.floor(s / 86_400), h = Math.floor(s % 86_400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d${h ? ` ${h}h` : ""}` : h ? `${h}h${m ? ` ${m}m` : ""}` : m ? `${m}m` : `${s}s`;
}

/**
 * The inputs a tool's `input_required` result asks for: MCP elicitations (form or url), and the
 * runtime's own approval and question requests. Anything else (sampling, roots) is refused.
 */
export function inputRequests(result: { inputRequests?: unknown }, inbox = false): { key: string; kind: Exclude<InputKind, "decision">; message: string; detail: Record<string, unknown> }[] {
  const requests = result.inputRequests;
  if (!requests || typeof requests !== "object" || Array.isArray(requests) || !Object.keys(requests).length) throw new Error("The tool asked for input but named none");
  const entries = Object.entries(requests as Record<string, any>);
  if (entries.length > INPUT_LIMITS.perCall) throw new Error(`The tool asked for more than ${INPUT_LIMITS.perCall} inputs at once`);
  return entries.map(([key, request]) => {
    const params = request?.params ?? {};
    if (request?.method === "agent-runtime/approval" && params.applyRecommendationOnExpiry) throw new Error("Approvals cannot apply recommendations on expiry");
    if (request?.method === "agent-runtime/approval") return { key, kind: "approval" as const, message: "", detail: params.reason ? { reason: clip(params.reason, 1000) } : {} };
    if (request?.method === "agent-runtime/question") return { key, kind: "question" as const, message: questionMessage(params.questions), detail: { ...(inbox ? params : {}), questions: questionsInput(params.questions) } };
    if (request?.method !== "elicitation/create") throw new Error(`The tool asked for input the runtime cannot give (${String(request?.method)})`);
    if (params.mode === "url") {
      let url: URL;
      try { url = new URL(params.url); } catch { throw new Error("The tool asked the user to open an invalid URL"); }
      if (url.protocol !== "https:") throw new Error("The tool asked the user to open a URL that is not https");
      return { key, kind: "url" as const, message: clip(params.message), detail: { url: url.toString(), origin: url.origin } };
    }
    const schema = params.requestedSchema;
    if (!schema || schema.type !== "object" || typeof schema.properties !== "object" || Object.values(schema.properties).some((field: any) => !["string", "number", "integer", "boolean"].includes(field?.type) && !Array.isArray(field?.enum) && field?.type !== "array")) {
      throw new Error("The tool asked for a form that is not a flat object of primitive fields");
    }
    return { key, kind: "form" as const, message: clip(params.message), detail: { requestedSchema: schema } };
  });
}

/**
 * ask_user's questions: 1–4, each with a header (a label of at most 12 characters; a longer one is clipped, a missing one
 * is the question's first words) and 2–4 options, or none: a question without options is answered in the person's
 * own words (allowOther). Models often write either shape; repaired rather than refused.
 */
export function questionsInput(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("Ask 1 to 4 questions");
  return value.map((entry: any) => {
    if (!entry || typeof entry.question !== "string" || !entry.question.trim()) throw new Error("Each question needs its text");
    // The header is only a label: models often write a longer one, which is clipped rather than refusing the question.
    if (entry.header !== undefined && typeof entry.header !== "string") throw new Error("A question's header is a label of at most 12 characters");
    const header = typeof entry.header === "string" && entry.header.trim() ? entry.header.trim() : firstWords(entry.question, 12);
    const open = entry.options === undefined || (Array.isArray(entry.options) && entry.options.length === 0);
    if (!open && (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4 || entry.options.some((option: any) => typeof option?.label !== "string" || !option.label.trim()))) throw new Error("Each question needs 2 to 4 options, each with a label, or none (answered in the person's own words)");
    const options: any[] = open ? [] : entry.options;
    if (entry.recommended !== undefined && (!options.some(option => option.label === entry.recommended) || typeof entry.reason !== "string" || !entry.reason.trim())) throw new Error("A recommended option needs its label and a reason");
    const labels = options.map((option: any) => option.label);
    if (new Set(labels).size !== labels.length) throw new Error("A question's option labels must differ");
    if (value.filter((other: any) => other?.question === entry.question).length > 1) throw new Error("Each question must be different");
    return {
      question: clip(entry.question, 1000), header: clip(header, 12).trimEnd(),
      options: options.map((option: any) => ({ label: clip(option.label, 200), ...(typeof option.description === "string" ? { description: clip(option.description, 1000) } : {}) })),
      ...(entry.recommended !== undefined ? { recommended: entry.recommended, reason: clip(entry.reason, 1000) } : {}),
      multiSelect: !open && entry.multiSelect === true, allowOther: open || entry.allowOther === true,
    };
  });
}
/** A header made from a question's first words, within `max` characters (at least its first word, clipped). */
function firstWords(text: string, max: number) {
  let header = "";
  for (const word of text.trim().split(/\s+/)) { const next = header ? `${header} ${word}` : word; if (next.length > max) break; header = next; }
  return header || text.trim().slice(0, max);
}
const questionMessage = (questions: unknown) => Array.isArray(questions) && questions.length === 1 ? clip((questions[0] as any)?.question, 1000) : `${Array.isArray(questions) ? questions.length : 0} questions`;

/** An answer from a request: its action, and content that fits what was asked. */
export function answerInput(input: Pick<Input, "kind" | "detail">, body: any): { action: Action; content?: unknown } {
  const action = body?.action;
  if (!["accept", "decline", "cancel"].includes(action)) throw new HttpError(400, "action is accept, decline or cancel");
  if (action !== "accept" || input.kind === "approval" || input.kind === "url") {
    if (body.content !== undefined && input.kind !== "approval" && input.kind !== "url") throw new HttpError(400, "Only an accepted answer has content");
    // An approval's decline may say why.
    const reason = input.kind === "approval" && action !== "accept" && typeof body.content?.reason === "string" ? { reason: clip(body.content.reason, 1000) } : undefined;
    return { action, ...(reason ? { content: reason } : {}) };
  }
  if (input.kind === "form") {
    if (!body.content || typeof body.content !== "object" || Array.isArray(body.content) || !schemaAccepts(input.detail.requestedSchema, body.content)) throw new HttpError(400, "content does not fit the form's schema");
    return { action, content: body.content };
  }
  if (input.kind === "decision" && typeof body.content === "string") return answerInput({ kind: "question", detail: input.detail }, { ...body, content: { answers: { [input.detail.title]: body.content } } });
  const answers = body.content?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new HttpError(400, "Answer questions with content: { answers: { \"<question>\": \"<label>\" | [\"<label>\", ...] | \"<your own words>\" } }");
  const checked: Record<string, string | string[]> = {};
  for (const question of input.detail.questions as { question: string; options: { label: string }[]; multiSelect: boolean; allowOther: boolean }[]) {
    const given = answers[question.question];
    const labels = question.options.map(option => option.label);
    const fits = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 2000 && (labels.includes(value) || question.allowOther);
    if (question.multiSelect ? !Array.isArray(given) || !given.length || !given.every(fits) : !fits(given)) {
      throw new HttpError(400, `Answer "${question.question}" with ${labels.length ? `${question.multiSelect ? "a list of" : "one of"} ${labels.map(label => JSON.stringify(label)).join(", ")}${question.allowOther ? ", or your own words" : ""}` : "your own words"}`);
    }
    checked[question.question] = given;
  }
  return { action, content: { answers: checked } };
}

/**
 * Whether a responder may answer: anyone the application vouches for, when the input is for no one
 * in particular; else only someone in its audience or the approvers, named with `from` or `actor`
 * (channels always name the sender). An answer that names no one is refused for such an input.
 */
export function mayAnswer(input: Pick<Input, "responders">, by: Responder, approvers: string[] = []) {
  if (by.system) return true;
  const who = by.from?.id ?? by.actor;
  const allowed = [...input.responders.audience ?? [], ...approvers];
  if (!allowed.length) return true;
  if (who === undefined) throw new HttpError(400, `This input is for ${allowed.join(", ")}: answer with from or actor naming who answers`);
  return allowed.includes(who);
}

/** Why a system-closed input got no answer, as the model reads it (an expired one: `timedOut`). */
const CLOSED: Record<"aborted" | "superseded", string> = {
  aborted: "Cancelled by the application before anyone answered.",
  superseded: "Not answered: the user sent a new message instead (next).",
};

/**
 * The runtime's automatic answer to an input no one answered in time, as the model reads it: never an approval (the
 * call did not run), and marked as the runtime's, not the user's.
 */
export function timedOut(kind: InputKind, waitedFor: string) {
  const automatic = `(An automatic answer from the runtime after ${waitedFor} without a response: the user did not write this.)`;
  if (kind === "approval") return `The user did not respond in a timely manner, so this call was not approved and did not run. Continue without it, or ask again later. ${automatic}`;
  if (kind === "question") return `The user did not respond in a timely manner. Continue. ${automatic}`;
  return `The user did not respond in a timely manner, so this request was cancelled and the call did not finish. Continue without it, or ask again later. ${automatic}`;
}

/** A late answer's refusal (409): what became of an input that settled without the answer given now. */
export function settledAlready(input: Pick<Input, "state" | "answer">) {
  if (input.answer?.by.system === "expired") return "This input expired: no one answered in time, so the runtime answered for the user and the agent went on without it. Send a new message instead";
  return `This input is already ${input.state}`;
}

/**
 * What one suspended call becomes once its inputs have settled: a result to give the model now,
 * or a plan to run the call again (an approved call, or a tool's own request answered).
 */
export function resolution(inputs: InputRow[], unseal: (row: InputRow) => string | undefined, now = Date.now()):
  { result: { content: { type: "text"; text: string }[]; isError?: boolean } } | { retry: RetryPlan } {
  const text = (value: string, isError = false) => ({ result: { content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) } });
  const last = inputs.reduce((latest, input) => Math.max(latest, input.answer?.at ?? 0), 0);
  const who = [...new Set(inputs.map(input => responderName(input.answer!.by)))].join(", ");
  const note = { answeredBy: who, waited: waited(last - Math.min(...inputs.map(input => input.createdAt))) };
  const closed = inputs.find(input => input.answer?.by.system && !(input.answer.by.system === "expired" && input.answer.action === "accept"));
  if (closed?.answer!.by.system === "expired") {
    // No one answered in time, so the runtime answers. A question gets an empty answer that the model and code read on
    // from; an approval is not given and a tool's own request is cancelled, so the call does not run (an error, as a
    // decline is).
    const expired = inputs.filter(input => input.answer?.by.system === "expired");
    const kind = expired.find(input => input.kind === "approval")?.kind ?? expired.find(input => input.kind !== "question")?.kind ?? "question";
    const message = timedOut(kind, note.waited);
    if (kind === "question") return text(JSON.stringify({ answers: {}, timedOut: true, message, ...note }));
    return text(message, true);
  }
  if (closed) return text(CLOSED[closed.answer!.by.system as "aborted" | "superseded"], true);
  // A question's answer is the call's result; nothing runs again.
  const question = inputs.find(input => input.kind === "question");
  if (question) {
    if (question.answer!.action !== "accept") return text(`The user declined to answer. ${JSON.stringify(note)}`, true);
    return text(JSON.stringify({ ...(question.answer!.content as object), ...note }));
  }
  const refused = inputs.find(input => input.kind === "approval" && input.answer!.action !== "accept");
  if (refused) {
    const reason = (refused.answer!.content as { reason?: string } | undefined)?.reason;
    return text(`The user declined this call${reason ? `: ${reason}` : ""}. It did not run. ${JSON.stringify(note)}`, true);
  }
  const approved = inputs.find(input => input.kind === "approval");
  // The tool's own requests are answered on the retry; an approval travels as proof of it (`approval`) instead.
  const keyed = inputs.filter(input => input.stored.key !== undefined && input.kind !== "approval");
  const requestState = keyed.map(unseal).find(state => state !== undefined);
  return { retry: {
    argumentsHash: inputs[0].stored.argumentsHash,
    ...(approved ? { approval: { input: approved.id, by: approved.answer!.by, at: approved.answer!.at } } : {}),
    ...(keyed.length ? { inputResponses: Object.fromEntries(keyed.map(input => [input.stored.key, { action: input.answer!.action, ...(input.answer!.content !== undefined && input.kind === "form" ? { content: input.answer!.content } : {}) }])) } : {}),
    ...(requestState !== undefined ? { requestState } : {}),
    note: `(${approved ? "Approved" : "Answered"} by ${note.answeredBy} after ${note.waited}.)`,
  } };
}

const row = (value: any): InputRow => {
  const { message, detail, responders } = value.input as Stored;
  return {
    id: value.id, agent: value.agent, tenant: value.tenant, requestId: value.request_id, toolCallId: value.tool_call_id, kind: value.kind,
    message, detail, responders, attachments: detail.attachments, links: detail.links, recommendation: detail.recommendation, applyRecommendationOnExpiry: detail.applyRecommendationOnExpiry, priority: value.priority ?? "normal", blocking: value.blocking ?? true, key: value.item_key ?? undefined, version: value.version ?? 1, state: value.state, ...(value.answer ? { answer: value.answer } : {}),
    createdAt: Number(value.created_at), expiresAt: Number(value.expires_at), stored: value.input,
  };
};
/** An input as callers see it: never how its call is retried. */
export const inputView = ({ stored: _stored, ...input }: InputRow): Input => input;

/** The webhook event for an input asked (`input.requested`) or settled (`input.resolved`), written with the row's change: its ids and key facts. */
const inputEvent = (type: "input.requested" | "input.resolved", input: InputRow): WebhookEvent => webhookEvent(type, input.tenant, {
  agentId: input.agent, requestId: input.requestId, inputId: input.id,
  ...(type === "input.requested" ? { toolCallId: input.toolCallId, kind: input.kind, expiresAt: input.expiresAt } : { state: input.state }),
}, `${type}:${input.id}`);

/** The `agent_inputs` rows. Creates are written under the agent's claim; settling is a compare-and-set any node may make. */
export class Inputs {
  readonly db: Db;
  private readonly sealer?: Sealer;
  constructor(options: { db: Db; sealer?: Sealer }) { this.db = options.db; this.sealer = options.sealer; }

  /**
   * Record a call's inputs. `requestState` is sealed when the runtime can seal. Made again (a retry whose first answer
   * was lost), it returns the rows the call's run already has pending, and records nothing new.
   */
  async create(base: Pick<Input, "agent" | "tenant" | "requestId" | "toolCallId" | "responders" | "expiresAt"> & {
    tool: string; argumentsHash: string; requestState?: string; blocking?: boolean; itemKey?: string; subject?: string;
    /** The definition's approvers (humanInput.approvers): with the audience, who may answer, frozen into `responders`. */
    approvers?: string[];
    /** The asking agent's chain (delegation.position): its root, and the chain from that root to it. */
    rootAgent?: string; lineage?: string[];
  },
    requests: { key?: string; kind: InputKind; message: string; detail: Record<string, unknown> }[], claim?: Claim): Promise<InputRow[]> {
    const createdAt = Date.now();
    // Who may answer, as the row holds it: the audience plus the approvers, frozen now (a later change to the definition
    // does not widen or narrow an item that was already asked).
    const responders = [...new Set([...base.responders.audience ?? [], ...base.approvers ?? []])];
    const lineage = base.lineage ?? (base.rootAgent === undefined ? undefined : [base.rootAgent]);
    const rootAgent = base.rootAgent ?? lineage?.[0];
    const rows = requests.map(request => {
      const id = `inp_${randomBytes(16).toString("hex")}`;
      const requestState = base.requestState === undefined ? undefined : this.sealer ? this.sealer.seal(`input:${base.agent}:${base.toolCallId}`, base.requestState) : base.requestState;
      const stored: Stored = {
        message: request.message, detail: request.detail, responders: base.responders, tool: base.tool, argumentsHash: base.argumentsHash,
        ...(request.key !== undefined ? { key: request.key } : {}), ...(requestState !== undefined ? { requestState } : {}),
      };
      return row({ id, agent: base.agent, tenant: base.tenant, request_id: base.requestId, tool_call_id: base.toolCallId, kind: request.kind, state: "pending", input: stored, created_at: createdAt, expires_at: base.expiresAt });
    });
    return underClaim(this.db, claim, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [base.agent]);
      const pending = (await sql.query("select * from agent_inputs where agent = $1 and request_id = $2 and tool_call_id = $3 and (state = 'pending' or not blocking) order by created_at, id",
        [base.agent, base.requestId, base.toolCallId])).rows.map(row);
      const keys = new Set(requests.map(request => request.key ?? null));
      const same = pending.filter(input => keys.has(input.stored.key ?? null));
      if (same.length === requests.length) return same;
      if (base.blocking === false && base.itemKey) {
        const older = (await sql.query("select id from agent_inputs where agent = $1 and item_key = $2 and not blocking and state = 'pending'", [base.agent, base.itemKey])).rows;
        for (const old of older) await this.settle(old.id, { action: "cancel", by: { system: "superseded" }, at: createdAt }, "withdrawn", sql);
      }
      for (const input of rows) {
        const priority: Priority = input.detail.priority ?? priorityOf(input.kind);
        input.priority = priority; input.blocking = base.blocking ?? true; input.key = base.itemKey;
        if (input.kind === "approval" && input.detail.applyRecommendationOnExpiry) throw new Error("Approvals cannot apply recommendations on expiry");
        await sql.query(`insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at,
          priority, priority_rank, blocking, responders, root_agent, lineage, item_key, subject)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $15, $12, $13, $14, $16, $17)`,
          [input.id, input.agent, input.tenant, input.requestId, input.toolCallId, input.kind, JSON.stringify(input.stored), input.createdAt, input.expiresAt,
            priority, PRIORITY_RANK[priority], responders, rootAgent ?? null, lineage ?? null, base.blocking ?? true, base.itemKey ?? null, base.subject ?? null]);
      }
      await enqueueEvents(sql, rows.map(input => inputEvent("input.requested", input)));
      // Heard by the inbox watchers of every node, in this transaction: a listener sees it once, at commit.
      await sql.query("select pg_notify($1, $2)", [INBOX_CHANNEL, base.tenant]);
      return rows;
    });
  }

  /** The tool's opaque request state, unsealed for its retry. */
  requestState(input: InputRow): string | undefined {
    const state = input.stored.requestState;
    if (state === undefined || typeof state === "string") return state;
    return this.sealer!.unseal(`input:${input.agent}:${input.toolCallId}`, state);
  }

  async get(id: string): Promise<InputRow | undefined> {
    if (!/^inp_[a-f0-9]{32}$/.test(id)) return undefined;
    const found = (await this.db.query("select * from agent_inputs where id = $1", [id])).rows[0];
    return found && row(found);
  }

  /** A suspension's inputs: those one run's calls asked for. */
  async forRequest(agent: string, requestId: string) {
    return (await this.db.query("select * from agent_inputs where agent = $1 and request_id = $2 and blocking order by created_at, id", [agent, requestId])).rows.map(row);
  }

  /** A tenant's inputs, newest first: one agent's, or all of them (the inbox). */
  async list(tenant: string, options: { agent?: string; state?: string; limit?: number } = {}) {
    const { rows } = await this.db.query(`select * from agent_inputs where tenant = $1 and ($2::text is null or agent = $2) and ($3::text is null or state = $3)
      order by created_at desc, id limit $4`, [tenant, options.agent ?? null, options.state ?? null, Math.min(Math.max(options.limit ?? 100, 1), 500)]);
    return rows.map(row);
  }

  async pending(agent: string) {
    return (await this.db.query("select * from agent_inputs where agent = $1 and state = 'pending' order by created_at, id", [agent])).rows.map(row);
  }

  /** Settle a pending input, once: undefined when it had already settled (or does not exist). Inside `sql`'s transaction, if given. */
  async settle(id: string, answer: Answer, state: InputState = FINAL[answer.action], sql?: Sql): Promise<InputRow | undefined> {
    const work = async (sql: Sql) => {
      const updated = (await sql.query("update agent_inputs set state = $2, answer = $3, version = version + 1, updated_at = now() where id = $1 and state = 'pending' returning *", [id, state, JSON.stringify(answer)])).rows[0];
      if (!updated) return undefined;
      await enqueueEvents(sql, [inputEvent("input.resolved", row(updated))]);
      await sql.query("select pg_notify($1, $2)", [INBOX_CHANNEL, updated.tenant]);
      const result = row(updated);
      if (result.blocking === false && state !== "withdrawn") await this.stageDecisions([result], sql);
      return result;
    };
    return sql ? work(sql) : transaction(this.db, work);
  }

  /** Settle several pending inputs, all or none: undefined when any had already settled. */
  async settleAll(answers: { id: string; answer: Answer }[]): Promise<InputRow[] | undefined> {
    const taken = new Error("An input had already settled");
    try {
      return await transaction(this.db, async sql => {
        const settled: InputRow[] = [];
        for (const { id, answer } of answers) {
          const done = await this.settle(id, answer, undefined, sql);
          if (!done) throw taken;
          settled.push(done);
        }
        await this.stageDecisions(settled.filter(input => input.blocking === false), sql);
        return settled;
      });
    } catch (error) { if (error === taken) return undefined; throw error; }
  }

  /** The answer transaction also records delivery intent; a crash is retried by the expiry sweep. */
  async stageDecisions(rows: InputRow[], sql: Sql) {
    if (!rows.length) return;
    const inputs = rows.map(row => row.id).sort();
    const delivery = { id: `decision_${createHash("sha256").update(inputs.join(",")).digest("hex").slice(0, 40)}`, inputs };
    await sql.query("update agent_inputs set input = jsonb_set(input, '{delivery}', $2::jsonb) where id = any($1::text[])", [inputs, JSON.stringify(delivery)]);
  }
  async deliveries(agent?: string) {
    const rows = (await this.db.query("select * from agent_inputs where not blocking and input ? 'delivery' and ($1::text is null or agent = $1) order by created_at, id limit 1000", [agent ?? null])).rows.map(row);
    const groups = new Map<string, InputRow[]>();
    for (const input of rows) {
      const id = input.stored.delivery!.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(input);
    }
    // The scan limit may cut through a batch whose items were asked at different times. Deliver it whole.
    for (const [id, group] of groups) if (group.length < group[0].stored.delivery!.inputs.length) {
      groups.set(id, (await this.db.query("select * from agent_inputs where input->'delivery'->>'id' = $1 order by id", [id])).rows.map(row));
    }
    return groups;
  }
  async delivered(id: string) {
    await this.db.query("update agent_inputs set input = input - 'delivery' where input->'delivery'->>'id' = $1", [id]);
  }

  /** Claim pending inputs past their expiry, a batch at a time; a claim left by a crashed node lapses after a minute. */
  async due(now = Date.now(), limit = 100): Promise<InputRow[]> {
    const { rows } = await this.db.query(`
      update agent_inputs set claimed_until = now() + interval '1 minute'
      where id in (select id from agent_inputs where state = 'pending' and expires_at <= $1 and (claimed_until is null or claimed_until <= now())
        order by expires_at limit $2 for update skip locked)
      returning *`, [now, limit]);
    return rows.map(row);
  }
}

/** When an input expires: the definition's `expiresInSeconds` (15 minutes by default, at most 30 days), and never after its agent. */
export function expiresAt(settings: HumanInputSettings | undefined, agentExpiresAt: number | null, now = Date.now()) {
  const seconds = Math.min(settings?.expiresInSeconds ?? INPUT_LIMITS.defaultExpiresSeconds, INPUT_LIMITS.maxExpiresSeconds);
  return Math.min(now + seconds * 1000, agentExpiresAt ?? Infinity);
}

/** A definition's `humanInput` settings, checked. */
export function humanInputSettings(value: unknown): HumanInputSettings {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["expiresInSeconds", "approvers"].includes(key))) throw new HttpError(400, "humanInput is { expiresInSeconds?, approvers? }");
  const { expiresInSeconds, approvers } = value as Record<string, unknown>;
  if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) || (expiresInSeconds as number) < 60 || (expiresInSeconds as number) > INPUT_LIMITS.maxExpiresSeconds)) throw new HttpError(400, `humanInput.expiresInSeconds is an integer from 60 to ${INPUT_LIMITS.maxExpiresSeconds}`);
  if (approvers !== undefined && (!Array.isArray(approvers) || approvers.length > 100 || approvers.some(entry => typeof entry !== "string" || !entry.trim() || entry.length > 200))) throw new HttpError(400, "humanInput.approvers is a list of at most 100 ids (an actor, or a channel sender like slack:U0123)");
  return value as HumanInputSettings;
}
