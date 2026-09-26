import { createHash, randomBytes } from "node:crypto";
import type { Sealed } from "./accounts.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { underClaim, type Claim } from "./ownership.ts";
import { canonical } from "../shared/durable-json.ts";
import { schemaAccepts } from "./tool-policy.ts";
import type { Sender } from "./sender.ts";

/**
 * Human input: a question the model asks (ask_user), an approval the runtime's policy or a tool asks
 * for, or a form or URL step a tool asks for (MCP's `input_required`). A tool call that needs one
 * does not finish: the turn suspends with the call open (agent-host.ts), and the input waits here,
 * a row in `agent_inputs`, for as long as it takes. Answers are compare-and-set from pending, so each
 * input settles once. When the last input of a suspension settles, a `resume` run gives each open
 * call its result: the answer itself, or the call run again with it (`RetryPlan`).
 */
export type InputKind = "question" | "approval" | "form" | "url";
export type InputState = "pending" | "answered" | "declined" | "cancelled" | "expired" | "superseded";
export type Action = "accept" | "decline" | "cancel";
/** Who answered: the application (its token, and whom it names), a channel's sender, or the runtime itself. */
export type Responder = { via?: "api" | "agent" | "channel"; from?: Sender; actor?: string; system?: "expired" | "aborted" | "superseded" };
export type Answer = { action: Action; content?: unknown; by: Responder; at: number };
export interface Input {
  id: string; agent: string; tenant: string; requestId: string; toolCallId: string;
  kind: InputKind; message: string;
  /** question: { questions }; approval: { tool, source, arguments, argumentsHash }; form: { requestedSchema }; url: { url, origin }. */
  detail: Record<string, any>;
  /** Who may answer, besides the definition's approvers: the person whose message started the turn. */
  responders: { audience?: string[] };
  state: InputState; answer?: Answer; createdAt: number; expiresAt: number;
}
/** What is stored beyond what callers see: how the call is retried once answered. */
type Stored = Pick<Input, "message" | "detail" | "responders"> & {
  /** The call's name and a hash of its arguments: a retry must be the same call. */
  tool: string; argumentsHash: string;
  /** The tool's own request's key (MCP `inputRequests`), answered by the same key on the retry. */
  key?: string;
  /** The tool's opaque `requestState`, sealed at rest; never shown to the model or callers. */
  requestState?: Sealed | string;
};
export type InputRow = Input & { stored: Stored };
/** How a call is run again once its inputs are answered: with the approval's proof, and the tool's requests' answers. */
export type RetryPlan = { argumentsHash: string; approval?: { input: string; by: Responder; at: number }; inputResponses?: Record<string, unknown>; requestState?: string; note: string };
export type HumanInputSettings = { expiresInSeconds?: number; onExpire?: "close" | "resume"; approvers?: string[] };
type Sealer = { seal(aad: string, plaintext: string): Sealed; unseal(aad: string, sealed: Sealed): string };

export const INPUT_LIMITS = Object.freeze({ defaultExpiresSeconds: 7 * 86_400, maxExpiresSeconds: 30 * 86_400, perCall: 8, text: 4_000, arguments: 4_000 });
const FINAL: Record<Action, InputState> = { accept: "answered", decline: "declined", cancel: "cancelled" };

export const argumentsHash = (name: string, args: unknown) => createHash("sha256").update(canonical({ name, arguments: args })).digest("hex");
const clip = (text: unknown, max: number = INPUT_LIMITS.text) => String(text ?? "").slice(0, max);

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
export function inputRequests(result: { inputRequests?: unknown }): { key: string; kind: InputKind; message: string; detail: Record<string, unknown> }[] {
  const requests = result.inputRequests;
  if (!requests || typeof requests !== "object" || Array.isArray(requests) || !Object.keys(requests).length) throw new Error("The tool asked for input but named none");
  const entries = Object.entries(requests as Record<string, any>);
  if (entries.length > INPUT_LIMITS.perCall) throw new Error(`The tool asked for more than ${INPUT_LIMITS.perCall} inputs at once`);
  return entries.map(([key, request]) => {
    const params = request?.params ?? {};
    if (request?.method === "agent-runtime/approval") return { key, kind: "approval" as const, message: "", detail: params.reason ? { reason: clip(params.reason, 1000) } : {} };
    if (request?.method === "agent-runtime/question") return { key, kind: "question" as const, message: questionMessage(params.questions), detail: { questions: questionsInput(params.questions) } };
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

/** ask_user's questions: 1–4, each with a header of at most 12 characters and 2–4 options. */
export function questionsInput(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("Ask 1 to 4 questions");
  return value.map((entry: any) => {
    if (!entry || typeof entry.question !== "string" || !entry.question.trim()) throw new Error("Each question needs its text");
    if (typeof entry.header !== "string" || !entry.header.trim() || entry.header.length > 12) throw new Error("Each question needs a header of at most 12 characters");
    if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4 || entry.options.some((option: any) => typeof option?.label !== "string" || !option.label.trim())) throw new Error("Each question needs 2 to 4 options, each with a label");
    const labels = entry.options.map((option: any) => option.label);
    if (new Set(labels).size !== labels.length) throw new Error("A question's option labels must differ");
    if (value.filter((other: any) => other?.question === entry.question).length > 1) throw new Error("Each question must be different");
    return {
      question: clip(entry.question, 1000), header: entry.header,
      options: entry.options.map((option: any) => ({ label: clip(option.label, 200), ...(typeof option.description === "string" ? { description: clip(option.description, 1000) } : {}) })),
      multiSelect: entry.multiSelect === true, allowOther: entry.allowOther === true,
    };
  });
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
  const answers = body.content?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new HttpError(400, "Answer questions with content: { answers: { \"<question>\": \"<label>\" | [\"<label>\", ...] | \"<your own words>\" } }");
  const checked: Record<string, string | string[]> = {};
  for (const question of input.detail.questions as { question: string; options: { label: string }[]; multiSelect: boolean; allowOther: boolean }[]) {
    const given = answers[question.question];
    const labels = question.options.map(option => option.label);
    const fits = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 2000 && (labels.includes(value) || question.allowOther);
    if (question.multiSelect ? !Array.isArray(given) || !given.length || !given.every(fits) : !fits(given)) {
      throw new HttpError(400, `Answer "${question.question}" with ${question.multiSelect ? "a list of" : "one of"} ${labels.map(label => JSON.stringify(label)).join(", ")}${question.allowOther ? ", or your own words" : ""}`);
    }
    checked[question.question] = given;
  }
  return { action, content: { answers: checked } };
}

/**
 * Whether a responder may answer: anyone the application vouches for, unless it names someone not
 * in the audience or the approvers. An API answer that names no one has the token's authority;
 * channels always name the sender.
 */
export function mayAnswer(input: Pick<Input, "responders">, by: Responder, approvers: string[] = []) {
  if (by.system) return true;
  const who = by.from?.id ?? by.actor;
  const allowed = [...input.responders.audience ?? [], ...approvers];
  return who === undefined || !allowed.length || allowed.includes(who);
}

/** Why a system-closed input got no answer, as the model reads it. */
const CLOSED: Record<NonNullable<Responder["system"]>, string> = {
  expired: "Not answered: the request for input expired.",
  aborted: "Cancelled by the application before anyone answered.",
  superseded: "Not answered: the user sent a new message instead (next).",
};

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
  const closed = inputs.find(input => input.answer?.by.system);
  if (closed) return text(CLOSED[closed.answer!.by.system!], true);
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
    message, detail, responders, state: value.state, ...(value.answer ? { answer: value.answer } : {}),
    createdAt: Number(value.created_at), expiresAt: Number(value.expires_at), stored: value.input,
  };
};
/** An input as callers see it: never how its call is retried. */
export const inputView = ({ stored: _stored, ...input }: InputRow): Input => input;

/** The `agent_inputs` rows. Creates are written under the agent's claim; settling is a compare-and-set any node may make. */
export class Inputs {
  readonly db: Db;
  private readonly sealer?: Sealer;
  constructor(options: { db: Db; sealer?: Sealer }) { this.db = options.db; this.sealer = options.sealer; }

  /** Record a call's inputs. `requestState` is sealed when the runtime can seal. */
  async create(base: Pick<Input, "agent" | "tenant" | "requestId" | "toolCallId" | "responders" | "expiresAt"> & { tool: string; argumentsHash: string; requestState?: string },
    requests: { key?: string; kind: InputKind; message: string; detail: Record<string, unknown> }[], claim?: Claim): Promise<InputRow[]> {
    const createdAt = Date.now();
    const rows = requests.map(request => {
      const id = `inp_${randomBytes(16).toString("hex")}`;
      const requestState = base.requestState === undefined ? undefined : this.sealer ? this.sealer.seal(`input:${base.agent}:${base.toolCallId}`, base.requestState) : base.requestState;
      const stored: Stored = {
        message: request.message, detail: request.detail, responders: base.responders, tool: base.tool, argumentsHash: base.argumentsHash,
        ...(request.key !== undefined ? { key: request.key } : {}), ...(requestState !== undefined ? { requestState } : {}),
      };
      return row({ id, agent: base.agent, tenant: base.tenant, request_id: base.requestId, tool_call_id: base.toolCallId, kind: request.kind, state: "pending", input: stored, created_at: createdAt, expires_at: base.expiresAt });
    });
    await underClaim(this.db, claim, async sql => {
      for (const input of rows) {
        await sql.query("insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [input.id, input.agent, input.tenant, input.requestId, input.toolCallId, input.kind, JSON.stringify(input.stored), input.createdAt, input.expiresAt]);
      }
    });
    return rows;
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
    return (await this.db.query("select * from agent_inputs where agent = $1 and request_id = $2 order by created_at, id", [agent, requestId])).rows.map(row);
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

  /** Settle a pending input, once: undefined when it had already settled (or does not exist). */
  async settle(id: string, answer: Answer, state: InputState = FINAL[answer.action], sql: Sql = this.db): Promise<InputRow | undefined> {
    const updated = (await sql.query("update agent_inputs set state = $2, answer = $3 where id = $1 and state = 'pending' returning *", [id, state, JSON.stringify(answer)])).rows[0];
    return updated && row(updated);
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
        return settled;
      });
    } catch (error) { if (error === taken) return undefined; throw error; }
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

/** When an input expires: the definition's `expiresInSeconds` (7 days by default, at most 30), and never after its agent. */
export function expiresAt(settings: HumanInputSettings | undefined, agentExpiresAt: number | null, now = Date.now()) {
  const seconds = Math.min(settings?.expiresInSeconds ?? INPUT_LIMITS.defaultExpiresSeconds, INPUT_LIMITS.maxExpiresSeconds);
  return Math.min(now + seconds * 1000, agentExpiresAt ?? Infinity);
}

/** A definition's `humanInput` settings, checked. */
export function humanInputSettings(value: unknown): HumanInputSettings {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["expiresInSeconds", "onExpire", "approvers"].includes(key))) throw new HttpError(400, "humanInput is { expiresInSeconds?, onExpire?, approvers? }");
  const { expiresInSeconds, onExpire, approvers } = value as Record<string, unknown>;
  if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) || (expiresInSeconds as number) < 60 || (expiresInSeconds as number) > INPUT_LIMITS.maxExpiresSeconds)) throw new HttpError(400, `humanInput.expiresInSeconds is an integer from 60 to ${INPUT_LIMITS.maxExpiresSeconds}`);
  if (onExpire !== undefined && onExpire !== "close" && onExpire !== "resume") throw new HttpError(400, "humanInput.onExpire is close or resume");
  if (approvers !== undefined && (!Array.isArray(approvers) || approvers.length > 100 || approvers.some(entry => typeof entry !== "string" || !entry.trim() || entry.length > 200))) throw new HttpError(400, "humanInput.approvers is a list of at most 100 ids (an actor, or a channel sender like slack:U0123)");
  return value as HumanInputSettings;
}
