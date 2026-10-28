import type { UsageRecord } from "./client-sessions/state.ts";
import type { AgentIdentity } from "./identity.ts";
import type { McpResult } from "./mcp-results.ts";
import type { ToolDefinition } from "./protocol.ts";
import { HttpError, errorStatus } from "./http.ts";
import { DECISION_LIMITS } from "./limits.ts";
import { safeError } from "./metrics.ts";

/**
 * Decisions: typed questions about one state (a message, a record, a document), answered by a decision model ("System
 * One" models such as TypeSafe's Jev) with calibrated probabilities instead of text. `POST /v1/decisions` and the `decide`
 * builtin (an agent's, and js_exec's `tools.decide`) ask through a `Decider`; a `DecisionProvider` (decision-providers.ts)
 * is the only part that knows a provider's wire format. Questions about one state go in one call, which answers them in
 * parallel; a batch (`items`) is many states, fanned out within the tenant's and the node's concurrency.
 *
 * Nothing is cached, and neither a state nor an answer is ever logged: logs carry counts, sizes, models and error
 * classes.
 */
export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type State = string | Record<string, unknown> | unknown[];
export type DecisionItem = { state: State; questions: Record<string, Question> };

/** noul: the probability the statement is true. */
export type NoulAnswer = { type: "noul"; noul: number };
/** choice: the likeliest option, its probability, and every option's. */
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
/** score: the expected level (0-based, may be fractional), the likeliest level's probability, and each level's. */
export type ScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: number[] };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The decision models the runtime prices, by OpenRouter id, in USD per million input tokens (output is free). */
export const DECISION_MODELS: Readonly<Record<string, { inputPerMillion: number }>> = Object.freeze({
  "typesafe/jev-1.14": { inputPerMillion: 0.042 },
  "typesafe/jev-1.13": { inputPerMillion: 0.042 },
});
/** The default: a pinned version, never an alias (`~typesafe/jev-latest`), so answers do not shift under thresholds. */
export const DECISION_MODEL = "typesafe/jev-1.14";

/**
 * An estimate's tokens before a provider counts: characters at 3 a token (low, so estimates run high), and what the
 * provider adds around each question and each call (Jev counted 444 input tokens for a 70-character state and three
 * short questions, about 520 characters in all).
 */
const CHARS_PER_TOKEN = 3, TOKENS_PER_QUESTION = 100, TOKENS_PER_CALL = 50;

const ID = /^[A-Za-z0-9_-]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, what: string) => {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${what} is a non-empty string`);
  if (value.length > max) throw new HttpError(400, `${what} is at most ${max} characters`);
  return value;
};

/** A question as given, checked: its type, instructions and criteria within the limits. */
export function questionInput(value: unknown, id: string): Question {
  const where = `questions.${id}`;
  if (!isRecord(value)) throw new HttpError(400, `${where} is {type, instructions, criteria?}`);
  const extra = Object.keys(value).filter(key => !["type", "instructions", "criteria"].includes(key));
  if (extra.length) throw new HttpError(400, `${where} has unknown fields: ${extra.join(", ")}`);
  const instructions = text(value.instructions, DECISION_LIMITS.instructionChars, `${where}.instructions`);
  const criterion = (entry: unknown, what: string) => text(entry, DECISION_LIMITS.criterionChars, what);
  switch (value.type) {
    case "noul": {
      if (value.criteria === undefined) return { type: "noul", instructions };
      if (!isRecord(value.criteria) || Object.keys(value.criteria).some(key => key !== "true" && key !== "false") || !Object.keys(value.criteria).length) throw new HttpError(400, `${where}.criteria is {true?, false?}: what counts as yes, and as no`);
      const criteria: NoulQuestion["criteria"] = {};
      for (const key of ["true", "false"] as const) if (value.criteria[key] !== undefined) criteria[key] = criterion(value.criteria[key], `${where}.criteria.${key}`);
      return { type: "noul", instructions, criteria };
    }
    case "choice": {
      if (!isRecord(value.criteria)) throw new HttpError(400, `${where}.criteria is {option: description}: the options to choose from`);
      const options = Object.entries(value.criteria);
      if (options.length < 2 || options.length > DECISION_LIMITS.choices) throw new HttpError(400, `${where}.criteria has 2 to ${DECISION_LIMITS.choices} options`);
      const criteria: Record<string, string> = {};
      for (const [name, description] of options) {
        if (!name.trim() || name.length > DECISION_LIMITS.idChars) throw new HttpError(400, `${where}.criteria's option names are 1 to ${DECISION_LIMITS.idChars} characters`);
        // A description may be empty: the option is judged by its name alone.
        criteria[name] = description === "" ? "" : criterion(description, `${where}.criteria.${name}`);
      }
      return { type: "choice", instructions, criteria };
    }
    case "score": {
      if (!Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > DECISION_LIMITS.levels) throw new HttpError(400, `${where}.criteria is 2 to ${DECISION_LIMITS.levels} levels, lowest first`);
      return { type: "score", instructions, criteria: value.criteria.map((level, index) => criterion(level, `${where}.criteria[${index}]`)) };
    }
    default: throw new HttpError(400, `${where}.type is noul, choice or score`);
  }
}

/** One state and its questions, checked. `where` names it in errors (`items[3]`). */
export function decisionItem(value: unknown, where = "The request"): DecisionItem {
  if (!isRecord(value)) throw new HttpError(400, `${where} is {state, questions}`);
  const { state, questions } = value;
  if (typeof state !== "string" && !isRecord(state) && !Array.isArray(state)) throw new HttpError(400, `${where}'s state is a string, an object or an array`);
  const stateChars = typeof state === "string" ? state.length : JSON.stringify(state).length;
  if (typeof state === "string" ? !state.trim() : stateChars <= 2) throw new HttpError(400, `${where}'s state is empty`);
  if (stateChars > DECISION_LIMITS.stateChars) throw new HttpError(413, `${where}'s state is ${stateChars} characters; a decision takes at most ${DECISION_LIMITS.stateChars}. Split it, or ask about a summary`, "DECISION_TOO_LARGE");
  if (!isRecord(questions) || !Object.keys(questions).length) throw new HttpError(400, `${where}'s questions is {id: {type, instructions, criteria?}}, at least one`);
  const ids = Object.keys(questions);
  if (ids.length > DECISION_LIMITS.questions) throw new HttpError(400, `${where} asks ${ids.length} questions; at most ${DECISION_LIMITS.questions} about one state`);
  const checked: Record<string, Question> = {};
  for (const id of ids) {
    if (!ID.test(id) || id.length > DECISION_LIMITS.idChars) throw new HttpError(400, `Question ids are letters, digits, _ and -, at most ${DECISION_LIMITS.idChars}: not ${JSON.stringify(id.slice(0, 80))}`);
    checked[id] = questionInput(questions[id], id);
  }
  const item = { state: state as State, questions: checked };
  const chars = itemChars(item);
  if (chars > DECISION_LIMITS.itemChars) throw new HttpError(413, `${where} is ${chars} characters with its questions; at most ${DECISION_LIMITS.itemChars}`, "DECISION_TOO_LARGE");
  return item;
}

/** What a request asks: one state (`state`, `questions`) or a batch (`items`), the model, and at most what it may cost. */
export type DecisionRequest = { items: DecisionItem[]; batch: boolean; model: string; maxUsd?: number };

/** A request as `POST /v1/decisions` and the decide tool take it (other fields are the caller's to take out first). */
export function decisionRequest(value: Record<string, unknown>): DecisionRequest {
  const { state, questions, items, model, maxUsd } = value;
  const extra = Object.keys(value).filter(key => !["state", "questions", "items", "model", "maxUsd"].includes(key));
  if (extra.length) throw new HttpError(400, `Unknown fields: ${extra.join(", ")}`);
  const batch = items !== undefined;
  if (batch === (state !== undefined || questions !== undefined)) throw new HttpError(400, "Ask about one state (state and questions) or a batch (items), one of them");
  if (batch && (!Array.isArray(items) || !items.length || items.length > DECISION_LIMITS.items)) throw new HttpError(400, `items is 1 to ${DECISION_LIMITS.items} {state, questions}`);
  const checked = batch ? (items as unknown[]).map((item, index) => decisionItem(item, `items[${index}]`)) : [decisionItem({ state, questions })];
  const chosen = model === undefined ? DECISION_MODEL : model;
  if (typeof chosen !== "string" || !Object.hasOwn(DECISION_MODELS, chosen)) throw new HttpError(400, `model is one of ${Object.keys(DECISION_MODELS).join(", ")}`);
  if (maxUsd !== undefined && (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd <= 0)) throw new HttpError(400, "maxUsd is a positive number of dollars");
  return { items: checked, batch, model: chosen, ...(maxUsd !== undefined ? { maxUsd } : {}) };
}

const itemChars = (item: DecisionItem) => (typeof item.state === "string" ? item.state.length : JSON.stringify(item.state).length) + JSON.stringify(item.questions).length;

/** What a provider answered for one state, before it is checked against the questions. */
export type ProviderDecision = { answers: unknown; model?: string; inputTokens: number; outputTokens: number; costUsd?: number };
/** A provider's key, as a model call resolves it: its key scope's, the tenant's own, else the platform's (`platform`). */
export type DecisionCredentials = { apiKey: string };

export interface DecisionProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, as for that provider's models. */
  id: string;
  /**
   * Whether it sends `dataCollection: "deny"` on to its provider (and the provider honours it). Without it, an agent or a
   * request that denies data collection is refused rather than sent.
   */
  dataPolicy?: boolean;
  decide(item: DecisionItem, model: string, credentials: DecisionCredentials, signal: AbortSignal, policy?: { dataCollection?: "deny" }): Promise<ProviderDecision>;
}

/** Why a provider did not decide: `status` as the runtime answers it. `transient`: it may succeed if asked again soon. */
export class DecisionFailed extends HttpError {
  transient: boolean;
  /** How long the provider asked to wait (Retry-After), in ms. */
  retryAfterMs?: number;
  constructor(status: number, message: string, options: { transient?: boolean; retryAfterMs?: number; code?: string } = {}) {
    super(status, message, options.code ?? (status === 502 ? "DECISION_FAILED" : undefined));
    this.transient = !!options.transient;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

const probability = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
const malformed = (id: string, why: string) => new DecisionFailed(502, `The decision model's answer to ${id} is malformed (${why})`);

/**
 * A provider's answers checked against the questions: each question answered, with its type's fields, probabilities
 * within 0..1. A choice's probabilities cover exactly its options (one the provider left out is 0); a score's are by
 * level, given as a list or keyed by level number or text.
 */
export function checkedAnswers(questions: Record<string, Question>, answers: unknown): Record<string, Answer> {
  if (!isRecord(answers)) throw new DecisionFailed(502, "The decision model answered without answers");
  const checked: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!isRecord(answer)) throw malformed(id, "missing");
    if (answer.type !== undefined && answer.type !== question.type) throw malformed(id, `type ${String(answer.type)}, asked ${question.type}`);
    if (question.type === "noul") {
      const noul = probability(answer.noul);
      if (noul === undefined) throw malformed(id, "no probability");
      checked[id] = { type: "noul", noul };
    } else if (question.type === "choice") {
      const given = isRecord(answer.probabilities) ? answer.probabilities : {};
      const probabilities = Object.fromEntries(Object.keys(question.criteria).map(name => [name, probability(given[name]) ?? 0]));
      const choice = typeof answer.choice === "string" && Object.hasOwn(question.criteria, answer.choice) ? answer.choice : undefined;
      if (!choice) throw malformed(id, "no option chosen of those given");
      checked[id] = { type: "choice", choice, confidence: probability(answer.confidence) ?? probabilities[choice]!, probabilities };
    } else {
      const given = answer.probabilities;
      const probabilities = question.criteria.map((level, index) => probability(Array.isArray(given) ? given[index] : isRecord(given) ? given[String(index)] ?? given[level] : undefined) ?? 0);
      const score = typeof answer.score === "number" && Number.isFinite(answer.score) ? Math.min(question.criteria.length - 1, Math.max(0, answer.score)) : undefined;
      if (score === undefined) throw malformed(id, "no score");
      checked[id] = { type: "score", score, confidence: probability(answer.confidence) ?? Math.max(...probabilities), probabilities };
    }
  }
  return checked;
}

/** One state's outcome in a batch: its answers and what they cost, or why it failed (the others still answered). */
export type ItemResult =
  | { answers: Record<string, Answer>; usage: { inputTokens: number; outputTokens: number }; costUsd: number }
  | { error: { status: number; code?: string; message: string } };

/**
 * A request's outcome: each item's, and its usage record for the caller to record (none when nothing was answered).
 * `costUsd` is what the provider charged; `chargedUsd` what the tenant pays for it (on the platform's key, what its
 * OpenRouter credits cost: `creditMultiplier` times), which an end user's hold settles at.
 */
export type Decided = { model: string; results: ItemResult[]; usage?: UsageRecord; costUsd: number; chargedUsd: number; inputTokens: number; outputTokens: number; ms: number };

export interface DeciderOptions {
  provider: DecisionProvider;
  /** The provider's key for a tenant (in a key scope), and whether it is the platform's; throws when the tenant may not use it (spent credit). */
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<(DecisionCredentials & { platform: boolean }) | undefined>;
  /** Dollars paid per dollar the provider charges on the platform's key (OpenRouter's credits); 1 by default. */
  creditMultiplier?: () => number;
  /** Waits between attempts; a test's may skip them. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: Partial<Record<"tenantConcurrent" | "nodeConcurrent" | "queued" | "tenantChars" | "nodeChars" | "attempts" | "backoffMs" | "callTimeoutMs" | "requestTimeoutMs", number>>;
}

/** Slots taken in order: at most `max` at once, the rest waiting (a stop takes a waiter out). */
class Gate {
  active = 0;
  readonly waiting: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  readonly max: number;
  constructor(max: number) { this.max = max; }
  /** Requests using it: a tenant's gate is dropped when the last one ends. */
  users = 0;
  async take(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (this.active < this.max) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener("abort", stop); resolve(); }, reject };
      const stop = () => { const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
      signal.addEventListener("abort", stop, { once: true });
      this.waiting.push(waiter);
    });
  }
  give() {
    const next = this.waiting.shift();
    if (next) next.resolve(); else this.active--;
  }
}

const abortable = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", stop, { once: true });
});

export class Decider {
  readonly options: DeciderOptions;
  readonly limits: Record<keyof typeof DECISION_LIMITS, number>;
  private readonly node: Gate;
  private readonly tenants = new Map<string, Gate>();
  /** Characters of state and question held by requests in flight: the node's, and each tenant's. */
  private held = 0;
  private readonly heldBy = new Map<string, number>();
  constructor(options: DeciderOptions) {
    this.options = options;
    this.limits = { ...DECISION_LIMITS, ...options.limits };
    this.node = new Gate(this.limits.nodeConcurrent);
  }

  get provider() { return this.options.provider.id; }

  /**
   * Why a tenant may not ask now on this node, before its request is read: as many of its decisions waiting as the queue
   * takes, or as many characters held as it may hold. A 429 then costs no body.
   */
  saturated(tenant: string): HttpError | undefined {
    if ((this.tenants.get(tenant)?.waiting.length ?? 0) >= this.limits.queued) return new HttpError(429, `Too many decisions waiting for this account on this node (at most ${this.limits.queued}): wait for some to finish`, "RATE_LIMITED");
    if ((this.heldBy.get(tenant) ?? 0) >= this.limits.tenantChars || this.held >= this.limits.nodeChars) return new HttpError(429, "Too many decisions in flight on this node: wait for some to finish", "RATE_LIMITED");
    return undefined;
  }

  /** What an item is estimated to cost (USD) before it is sent: its characters as tokens, at the model's price. */
  estimate(items: DecisionItem[], model: string) {
    const price = DECISION_MODELS[model]?.inputPerMillion ?? 0;
    return items.reduce((total, item) => total + (Math.ceil(itemChars(item) / CHARS_PER_TOKEN) + TOKENS_PER_QUESTION * Object.keys(item.questions).length + TOKENS_PER_CALL) * price / 1_000_000, 0);
  }

  /**
   * Answer a checked request (`decisionRequest`) for a tenant. Its estimate is checked against `budget` (what the run or
   * agent may still spend, USD) and the request's `maxUsd` before anything is sent. Items run at most the tenant's and
   * the node's concurrency at once; a call the provider failed for now is retried with backoff (its Retry-After within
   * the request's deadline). An item that fails does not fail the others. The usage record (cost in `usage.cost.total`,
   * `platform` when on the platform's key) is the caller's to record, with the run's facts.
   */
  async decide(context: { tenant: string; keyScope?: string; budget?: number; dataCollection?: "deny" | null }, request: DecisionRequest, signal: AbortSignal): Promise<Decided> {
    const { provider } = this.options;
    // States are sent only where the agent's data policy holds: refused, not sent, where it cannot be passed on.
    if (context.dataCollection === "deny" && !provider.dataPolicy) throw new HttpError(400, "Decisions cannot honour dataCollection \"deny\" yet: OpenRouter's decisions API has not been confirmed to take a data policy, so nothing was sent", "DECISIONS_DATA_POLICY");
    const policy = context.dataCollection === "deny" ? { dataCollection: "deny" as const } : undefined;
    const estimate = this.estimate(request.items, request.model);
    if (request.maxUsd !== undefined && estimate > request.maxUsd) throw new HttpError(402, `These decisions cost about $${estimate.toFixed(6)}, more than maxUsd ($${request.maxUsd})`, "SPEND_LIMIT");
    if (context.budget !== undefined && estimate > context.budget) throw new HttpError(402, `These decisions cost about $${estimate.toFixed(6)}, more than the $${Math.max(0, context.budget).toFixed(6)} left of this run's spend limit`, "SPEND_LIMIT");
    const key = await this.options.key(context.tenant, context.keyScope, provider.id);
    if (!key) throw new HttpError(400, `Decisions need an OpenRouter key: add one under Models & keys (PUT /v1/providers/${provider.id}/key)${context.keyScope ? `, or to key scope ${context.keyScope}` : ""}`, "DECISIONS_UNAVAILABLE");
    const { platform, ...credentials } = key;
    let tenant = this.tenants.get(context.tenant);
    if (tenant && tenant.waiting.length + request.items.length > this.limits.queued + this.limits.tenantConcurrent) throw new HttpError(429, `Too many decisions waiting for this account on this node (at most ${this.limits.queued}): wait for some to finish`, "RATE_LIMITED");
    // What the request holds while it runs, within the tenant's and the node's bounds.
    const chars = request.items.reduce((total, item) => total + itemChars(item), 0);
    const tenantHeld = this.heldBy.get(context.tenant) ?? 0;
    if (tenantHeld + chars > this.limits.tenantChars || this.held + chars > this.limits.nodeChars) throw new HttpError(429, "Too many decisions in flight on this node: wait for some to finish", "RATE_LIMITED");
    this.heldBy.set(context.tenant, tenantHeld + chars);
    this.held += chars;
    if (!tenant) this.tenants.set(context.tenant, tenant = new Gate(this.limits.tenantConcurrent));
    tenant.users++;
    const started = Date.now();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.limits.requestTimeoutMs)]);
    let served = request.model;
    const results = await Promise.all(request.items.map(async (item): Promise<ItemResult> => {
      try {
        const answered = await this.call(tenant, item, request.model, credentials, deadline, policy);
        if (answered.model) served = answered.model;
        const reported = typeof answered.costUsd === "number" && Number.isFinite(answered.costUsd) && answered.costUsd >= 0;
        // The provider's cost, else its tokens at the model's price, else (it said neither) the estimate: never $0 unsaid.
        const costUsd = reported ? answered.costUsd! : answered.inputTokens > 0 ? answered.inputTokens * (DECISION_MODELS[request.model]!.inputPerMillion) / 1_000_000 : this.estimate([item], request.model);
        if (!reported) console.log(JSON.stringify({ type: "decision_usage_untrusted", tenant: context.tenant, provider: provider.id, model: request.model, inputTokens: answered.inputTokens, usd: costUsd }));
        return { answers: checkedAnswers(item.questions, answered.answers), usage: { inputTokens: answered.inputTokens, outputTokens: answered.outputTokens }, costUsd };
      } catch (error) {
        if (signal.aborted) throw error;
        const status = deadline.aborted ? 504 : errorStatus(error, 502);
        const message = deadline.aborted ? `No answer within ${this.limits.requestTimeoutMs} ms` : error instanceof HttpError ? error.message : `The decision failed (${safeError(error)})`;
        return { error: { status, ...(error instanceof HttpError && error.code ? { code: error.code } : {}), message } };
      }
    })).finally(() => {
      if (--tenant.users === 0) this.tenants.delete(context.tenant);
      this.held -= chars;
      const left = (this.heldBy.get(context.tenant) ?? 0) - chars;
      if (left > 0) this.heldBy.set(context.tenant, left); else this.heldBy.delete(context.tenant);
    });
    // Billed for the items answered; one that failed (a malformed answer included) is not.
    let inputTokens = 0, outputTokens = 0, costUsd = 0, decisions = 0;
    for (const [index, result] of results.entries()) {
      if (!("answers" in result)) continue;
      inputTokens += result.usage.inputTokens; outputTokens += result.usage.outputTokens; costUsd += result.costUsd;
      decisions += Object.keys(request.items[index]!.questions).length;
    }
    const failed = results.filter(result => "error" in result).length;
    const ms = Date.now() - started;
    console.log(JSON.stringify({ type: "decided", tenant: context.tenant, provider: provider.id, model: request.model, items: request.items.length, decisions, failed, inputTokens, ms }));
    const usage: UsageRecord | undefined = decisions ? {
      provider: provider.id, model: request.model, kind: "decision", platform, decisions, timestamp: Date.now(),
      usage: { input: inputTokens, output: outputTokens, cost: { total: costUsd } },
    } : undefined;
    const chargedUsd = platform ? costUsd * (this.options.creditMultiplier?.() ?? 1) : costUsd;
    return { model: served, results, ...(usage ? { usage } : {}), costUsd, chargedUsd, inputTokens, outputTokens, ms };
  }

  /** One item, within the gates, retried while the provider fails for now and the deadline allows. */
  private async call(tenant: Gate, item: DecisionItem, model: string, credentials: DecisionCredentials, deadline: AbortSignal, policy?: { dataCollection?: "deny" }): Promise<ProviderDecision> {
    const { attempts, backoffMs, callTimeoutMs } = this.limits;
    const sleep = this.options.sleep ?? abortable;
    for (let attempt = 1; ; attempt++) {
      let failed: DecisionFailed;
      await tenant.take(deadline);
      try {
        await this.node.take(deadline);
        const timeout = AbortSignal.timeout(callTimeoutMs);
        try {
          return await this.options.provider.decide(item, model, credentials, AbortSignal.any([deadline, timeout]), policy);
        } catch (error) {
          // The call's own timeout (not the request's): a slow call, which another attempt may answer.
          if (timeout.aborted && !deadline.aborted) throw new DecisionFailed(502, `No answer within ${callTimeoutMs} ms`, { transient: true });
          throw error;
        } finally { this.node.give(); }
      } catch (error) {
        if (deadline.aborted || !(error instanceof DecisionFailed && error.transient) || attempt >= attempts) throw error;
        failed = error;
      } finally { tenant.give(); }
      // Back off outside the gates, so a rate-limited call does not hold a slot.
      await sleep(failed.retryAfterMs ?? backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random()), deadline);
    }
  }
}

/** What `POST /v1/decisions` is asked, checked (`decisionRequest`), with who it is for and who pays. */
export type DecisionsRequest = DecisionRequest & {
  keyScope?: string;
  /** "deny": only where the provider takes the data policy, as an agent's dataCollection; refused otherwise. */
  dataCollection?: "deny";
  /** Who it is for and who asked, as an agent's identity and a run's actor say (`usage.recorded`'s subject, context and actor). */
  identity?: AgentIdentity; actor?: string;
  /** When its end user pays for it: holds the estimate (USD) of their credit before anything is sent. */
  hold?: (usd: number) => Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
};

export interface DecisionService {
  decider: Decider;
  /** Refuses a tenant that may not ask now (runs per minute, a monthly cap, spent credit); throws. */
  admit(tenant: string): Promise<void>;
  /** Records the decisions' usage, as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
}

/** Decisions asked for alone (`POST /v1/decisions`): nothing is kept of the state or the answers. */
export async function decisionsRequest(service: DecisionService, tenant: string, request: DecisionsRequest, signal: AbortSignal) {
  await service.admit(tenant);
  const held = await request.hold?.(service.decider.estimate(request.items, request.model));
  let decided: Decided;
  try { decided = await service.decider.decide({ tenant, ...(request.keyScope ? { keyScope: request.keyScope } : {}), ...(request.dataCollection ? { dataCollection: request.dataCollection } : {}) }, request, signal); }
  catch (error) { await held?.release(); throw error; }
  if (decided.usage) service.record(tenant, { ...decided.usage, ...(request.actor ? { actor: request.actor } : {}), ...(request.identity ? { identity: request.identity } : {}), ...(request.keyScope ? { keyScope: request.keyScope } : {}) });
  await held?.settle(decided.chargedUsd);
  return decisionsAnswer(decided, request.batch);
}

/** A request's outcome as it is answered: one state's answers (its failure thrown), or a batch's results in order. */
export function decisionsAnswer(decided: Decided, batch: boolean) {
  const { model, results, costUsd, inputTokens, outputTokens, ms } = decided;
  const usage = { inputTokens, outputTokens };
  if (batch) return { model, results, usage, costUsd, ms };
  const only = results[0]!;
  if ("error" in only) throw new HttpError(only.error.status, only.error.message, only.error.code);
  return { model, answers: only.answers, usage, costUsd, ms };
}

const QUESTIONS_SCHEMA = {
  type: "object", description: "Questions about the state, by an id you choose; answers come back under the same ids",
  additionalProperties: { type: "object", required: ["type", "instructions"], properties: {
    type: { type: "string", enum: ["noul", "choice", "score"] },
    instructions: { type: "string", description: "noul: a yes/no question or statement; choice: what to decide; score: what to rate" },
    criteria: { description: "noul: {true?, false?} (optional); choice: {option: description}, 2 to 255; score: levels lowest first, 2 to 10" },
  } },
};

/** The decide builtin: an agent's, called directly or from js_exec as `tools.decide(...)`. */
export const DECIDE: ToolDefinition = {
  name: "decide", exposure: "both",
  description: "Answer typed questions about a state (text or JSON) fast and cheaply with a decision model, with calibrated probabilities: noul (yes/no: the probability of yes), choice (one of named options), score (a level on a scale). Ask every question about one state in one call: they are answered together. For many states pass items (up to 100 per call; in js_exec, call tools.decide({items}) for each chunk of a dataset and await a few chunks at a time). About $0.00002 a call of three questions. Answers: {answers: {id: {type, noul} | {type, choice, confidence, probabilities} | {type, score, confidence, probabilities}}}, or for items {results: [{answers} | {error}]} in order. Nothing is cached: send each distinct state once.",
  parameters: { type: "object", additionalProperties: false, properties: {
    state: { description: "What every question is about: a string, object or array (at most 64,000 characters)" },
    questions: QUESTIONS_SCHEMA,
    items: { type: "array", maxItems: DECISION_LIMITS.items, description: "A batch instead of state and questions: [{state, questions}]", items: { type: "object", required: ["state", "questions"], properties: { state: {}, questions: QUESTIONS_SCHEMA } } },
    model: { type: "string", enum: Object.keys(DECISION_MODELS), description: `Default ${DECISION_MODEL}` },
    maxUsd: { type: "number", description: "Refuse before anything is sent if the estimate is more" },
  } },
};

/**
 * A decide call: its arguments checked, answered within `budget` (USD, when the run or agent has a limit). `record` takes
 * its usage as soon as it is answered. `hold`, when its end user pays for it, holds the estimate of their credit first.
 */
export async function decideTool(decider: Decider, context: { tenant: string; keyScope?: string; budget?: number; dataCollection?: "deny" | null; record(usage: UsageRecord): void; hold?: DecisionsRequest["hold"] }, args: Record<string, unknown>, signal: AbortSignal): Promise<McpResult> {
  const request = decisionRequest(args ?? {});
  const held = await context.hold?.(decider.estimate(request.items, request.model));
  let decided: Decided;
  try { decided = await decider.decide({ tenant: context.tenant, ...(context.keyScope ? { keyScope: context.keyScope } : {}), ...(context.budget !== undefined ? { budget: context.budget } : {}), ...(context.dataCollection ? { dataCollection: context.dataCollection } : {}) }, request, signal); }
  catch (error) { await held?.release(); throw error; }
  if (decided.usage) context.record(decided.usage);
  await held?.settle(decided.chargedUsd);
  const value = decisionsAnswer(decided, request.batch);
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
