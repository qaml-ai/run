import { randomId } from "./crypto.ts";
import {
  DEFAULT_MODEL_ID,
  calculateCostUsd,
  isReasoningModel,
  parsePiModelRef,
  resolveTenantByokProvider,
  streamPiModel,
} from "./pi/models.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, estimateTokens, type Env, type ProviderCredentials } from "./types.ts";

export const DEFAULT_DECISION_MODEL_ID = "openai/gpt-4.1-mini";
export const MAX_STATE_CHARS = 64_000;
export const MAX_QUESTIONS = 32;
export const MAX_BATCH_ITEMS = 100;
export const MAX_CHOICE_CRITERIA = 255;
export const MAX_SCORE_CRITERIA = 32;
const BATCH_CONCURRENCY = 5;

export interface DecisionRequest {
  input: string;
  choices: string[];
  instructions?: string;
  model?: string;
  keyScope?: string;
  context?: unknown;
  subject?: string;
  actor?: string;
  bucket?: string;
  maxUsd?: number;
}

export interface DecisionResponse {
  choice: string;
  confidence: number;
  scores: Record<string, number>;
  costUsd: number;
}

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface DecisionItem {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: number[] };

export interface DecisionCommonOptions {
  model?: string;
  keyScope?: string;
  context?: unknown;
  subject?: string;
  actor?: string;
  bucket?: string;
  maxUsd?: number;
  dataCollection?: string;
}

export interface StructuredDecisionRequest extends DecisionItem, DecisionCommonOptions {}

export interface StructuredDecisionBatchRequest extends DecisionCommonOptions {
  items: DecisionItem[];
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredDecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  costUsd: number;
  ms: number;
}

export type StructuredBatchItemResult =
  | { answers: Record<string, DecisionAnswer>; usage: DecisionUsage; costUsd: number }
  | { error: { message: string } };

export interface StructuredDecisionBatchResponse {
  model: string;
  results: StructuredBatchItemResult[];
  usage: DecisionUsage;
  costUsd: number;
  ms: number;
}

export type DecisionEndpointRequest =
  | DecisionRequest
  | StructuredDecisionRequest
  | StructuredDecisionBatchRequest;

export type DecisionEndpointResponse =
  | DecisionResponse
  | StructuredDecisionResponse
  | StructuredDecisionBatchResponse;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1);
}

function normalizeProbabilitiesArray(rawValues: number[]): number[] {
  const n = rawValues.length;
  if (n === 0) return [];
  const cleaned = rawValues.map((v) => (Number.isFinite(v) && v >= 0 ? v : 0));
  const total = cleaned.reduce((a, b) => a + b, 0);
  const probs = total <= 0 ? cleaned.map(() => 1 / n) : cleaned.map((v) => v / total);
  const scale = 1_000_000;
  const scaled = probs.map((p) => Math.floor(p * scale));
  const remainder = scale - scaled.reduce((a, b) => a + b, 0);
  const order = probs
    .map((p, idx) => ({ idx, frac: p * scale - scaled[idx]! }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remainder && i < order.length; i++) {
    scaled[order[i]!.idx]! += 1;
  }
  return scaled.map((s) => s / scale);
}

function clamp01(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

function computeDeterministicScores(
  input: string,
  choices: string[],
  instructions?: string,
): Record<string, number> {
  const inputLower = `${input} ${instructions ?? ""}`.toLowerCase();
  const inputWords = new Set(tokenizeWords(inputLower));

  const logits: number[] = choices.map((choice, idx) => {
    const choiceLower = choice.toLowerCase();
    let logit = 0.1 - idx * 0.01;
    if (inputLower.includes(choiceLower)) {
      logit += 3.2;
    }
    const choiceTokens = tokenizeWords(choiceLower);
    for (const tok of choiceTokens) {
      if (inputWords.has(tok)) {
        logit += 2.0;
      } else {
        for (const iw of inputWords) {
          if (
            iw.length >= 4 &&
            tok.length >= 4 &&
            (iw.startsWith(tok.slice(0, 4)) || tok.startsWith(iw.slice(0, 4)))
          ) {
            logit += 1.1;
          }
        }
      }
    }
    return logit;
  });

  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const normalized = normalizeProbabilitiesArray(exps);

  const scores: Record<string, number> = {};
  for (let i = 0; i < choices.length; i++) {
    scores[choices[i]!] = normalized[i]!;
  }
  return scores;
}

function normalizeScoreMap(
  raw: Record<string, unknown>,
  choices: string[],
): Record<string, number> {
  const values = choices.map((c) => Number(raw[c] ?? 0));
  const normalized = normalizeProbabilitiesArray(values);
  const out: Record<string, number> = {};
  for (let i = 0; i < choices.length; i++) {
    out[choices[i]!] = normalized[i]!;
  }
  return out;
}

export function resolveDecisionModel(env: Env, rawModel?: unknown): string {
  if (rawModel !== undefined) {
    if (typeof rawModel !== "string" || !rawModel.trim()) {
      throw new ApiError(400, "invalid_request", "`model` must be a non-empty string");
    }
    return rawModel.trim();
  }
  const envDefault = env.DEFAULT_MODEL?.trim();
  if (envDefault && (envDefault === "mock" || envDefault.startsWith("mock/"))) {
    return envDefault;
  }
  if (env.OPENAI_API_KEY) {
    return DEFAULT_DECISION_MODEL_ID;
  }
  if (env.AZURE_OPENAI_LUNA_ENDPOINT && env.AZURE_OPENAI_LUNA_API_KEY) {
    return "azure/gpt-6-luna";
  }
  return (envDefault || DEFAULT_MODEL_ID).trim();
}

function validateCommonOptions(req: DecisionCommonOptions): {
  keyScope: string | null;
  actor: string | undefined;
  maxUsd: number | undefined;
} {
  let keyScope: string | null = null;
  if (req.keyScope !== undefined && req.keyScope !== null) {
    if (typeof req.keyScope !== "string") {
      throw new ApiError(400, "invalid_request", "`keyScope` must be a string");
    }
    keyScope = req.keyScope.trim() || null;
  }

  let actor: string | undefined;
  if (req.actor !== undefined && req.actor !== null) {
    if (typeof req.actor !== "string") {
      throw new ApiError(400, "invalid_request", "`actor` must be a string");
    }
    actor = req.actor.trim() || undefined;
  } else if (req.subject !== undefined && req.subject !== null) {
    if (typeof req.subject !== "string") {
      throw new ApiError(400, "invalid_request", "`subject` must be a string");
    }
    actor = req.subject.trim() || undefined;
  }

  if (req.bucket !== undefined && req.bucket !== null && typeof req.bucket !== "string") {
    throw new ApiError(400, "invalid_request", "`bucket` must be a string");
  }

  let maxUsd: number | undefined;
  if (req.maxUsd !== undefined) {
    if (typeof req.maxUsd !== "number" || !Number.isFinite(req.maxUsd) || req.maxUsd < 0) {
      throw new ApiError(400, "invalid_request", "`maxUsd` must be a non-negative finite number");
    }
    maxUsd = req.maxUsd;
  }

  return { keyScope, actor, maxUsd };
}

interface ValidatedDecisionItem {
  stateText: string;
  stateForPrompt: DecisionState;
  questions: Record<string, DecisionQuestion>;
  questionIds: string[];
}

function validateState(rawState: unknown): { stateText: string; stateForPrompt: DecisionState } {
  if (rawState === undefined || rawState === null) {
    throw new ApiError(400, "invalid_request", "`state` is required");
  }
  let stateText: string;
  if (typeof rawState === "string") {
    if (!rawState.trim()) {
      throw new ApiError(400, "invalid_request", "`state` must be a non-empty string");
    }
    stateText = rawState;
  } else if (typeof rawState === "object") {
    try {
      stateText = JSON.stringify(rawState);
    } catch {
      throw new ApiError(400, "invalid_request", "`state` must be JSON-serializable");
    }
    if (typeof stateText !== "string") {
      throw new ApiError(400, "invalid_request", "`state` must be a non-empty string, object, or array");
    }
  } else {
    throw new ApiError(400, "invalid_request", "`state` must be a non-empty string, object, or array");
  }
  if (stateText.length > MAX_STATE_CHARS) {
    throw new ApiError(
      413,
      "decision_too_large",
      `\`state\` exceeds maximum length of ${MAX_STATE_CHARS} characters`,
    );
  }
  return { stateText, stateForPrompt: rawState as DecisionState };
}

function validateQuestions(rawQuestions: unknown): {
  questions: Record<string, DecisionQuestion>;
  questionIds: string[];
} {
  if (!isPlainObject(rawQuestions)) {
    throw new ApiError(400, "invalid_request", "`questions` must be a non-empty object");
  }
  const questionIds = Object.keys(rawQuestions);
  if (questionIds.length === 0) {
    throw new ApiError(400, "invalid_request", "`questions` must be a non-empty object");
  }
  if (questionIds.length > MAX_QUESTIONS) {
    throw new ApiError(
      400,
      "invalid_request",
      `\`questions\` may contain at most ${MAX_QUESTIONS} questions`,
    );
  }

  const normalized: Record<string, DecisionQuestion> = {};
  for (const qid of questionIds) {
    if (!qid.trim()) {
      throw new ApiError(400, "invalid_request", "Question IDs must be non-empty strings");
    }
    const raw = rawQuestions[qid];
    if (!isPlainObject(raw)) {
      throw new ApiError(400, "invalid_request", `Question '${qid}' must be an object`);
    }
    if (typeof raw.instructions !== "string" || !raw.instructions.trim()) {
      throw new ApiError(
        400,
        "invalid_request",
        `Question '${qid}' must include non-empty string \`instructions\``,
      );
    }
    const instructions = raw.instructions.trim();

    if (raw.type === "noul") {
      let criteria: { true?: string; false?: string } | undefined;
      if (raw.criteria !== undefined) {
        if (!isPlainObject(raw.criteria)) {
          throw new ApiError(
            400,
            "invalid_request",
            `Question '${qid}' noul \`criteria\` must be an object with optional \`true\`/\`false\` strings`,
          );
        }
        if (raw.criteria.true !== undefined && typeof raw.criteria.true !== "string") {
          throw new ApiError(400, "invalid_request", `Question '${qid}' criteria.true must be a string`);
        }
        if (raw.criteria.false !== undefined && typeof raw.criteria.false !== "string") {
          throw new ApiError(400, "invalid_request", `Question '${qid}' criteria.false must be a string`);
        }
        criteria = {
          ...(raw.criteria.true !== undefined ? { true: raw.criteria.true } : {}),
          ...(raw.criteria.false !== undefined ? { false: raw.criteria.false } : {}),
        };
      }
      normalized[qid] = { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
    } else if (raw.type === "choice") {
      if (!isPlainObject(raw.criteria)) {
        throw new ApiError(
          400,
          "invalid_request",
          `Question '${qid}' choice \`criteria\` must be an object mapping option keys to descriptions`,
        );
      }
      const optionKeys = Object.keys(raw.criteria);
      if (optionKeys.length < 2) {
        throw new ApiError(
          400,
          "invalid_request",
          `Question '${qid}' choice \`criteria\` must have at least 2 options`,
        );
      }
      if (optionKeys.length > MAX_CHOICE_CRITERIA) {
        throw new ApiError(
          400,
          "invalid_request",
          `Question '${qid}' choice \`criteria\` may have at most ${MAX_CHOICE_CRITERIA} options`,
        );
      }
      const criteria: Record<string, string> = {};
      for (const opt of optionKeys) {
        if (!opt.trim()) {
          throw new ApiError(
            400,
            "invalid_request",
            `Question '${qid}' choice option keys must be non-empty strings`,
          );
        }
        const desc = raw.criteria[opt];
        if (typeof desc !== "string") {
          throw new ApiError(
            400,
            "invalid_request",
            `Question '${qid}' choice option '${opt}' description must be a string`,
          );
        }
        criteria[opt] = desc;
      }
      normalized[qid] = { type: "choice", instructions, criteria };
    } else if (raw.type === "score") {
      if (!Array.isArray(raw.criteria) || raw.criteria.length < 2) {
        throw new ApiError(
          400,
          "invalid_request",
          `Question '${qid}' score \`criteria\` must be an array of at least 2 strings`,
        );
      }
      if (raw.criteria.length > MAX_SCORE_CRITERIA) {
        throw new ApiError(
          400,
          "invalid_request",
          `Question '${qid}' score \`criteria\` may have at most ${MAX_SCORE_CRITERIA} levels`,
        );
      }
      const criteria: string[] = [];
      for (let i = 0; i < raw.criteria.length; i++) {
        if (typeof raw.criteria[i] !== "string") {
          throw new ApiError(
            400,
            "invalid_request",
            `Question '${qid}' score criteria[${i}] must be a string`,
          );
        }
        criteria.push(raw.criteria[i] as string);
      }
      normalized[qid] = { type: "score", instructions, criteria };
    } else {
      throw new ApiError(
        400,
        "invalid_request",
        `Question '${qid}' has invalid type; expected 'noul', 'choice', or 'score'`,
      );
    }
  }

  return { questions: normalized, questionIds };
}

function validateDecisionItem(rawItem: unknown): ValidatedDecisionItem {
  if (!isPlainObject(rawItem)) {
    throw new ApiError(400, "invalid_request", "Each decision item must be an object with `state` and `questions`");
  }
  const { stateText, stateForPrompt } = validateState(rawItem.state);
  const { questions, questionIds } = validateQuestions(rawItem.questions);
  return { stateText, stateForPrompt, questions, questionIds };
}

function estimateStructuredItemTokens(item: ValidatedDecisionItem): {
  inputTokens: number;
  outputTokens: number;
} {
  let promptOverhead = 140;
  let outputTokens = 16;
  for (const qid of item.questionIds) {
    const q = item.questions[qid]!;
    promptOverhead += estimateTokens(q.instructions) + 32;
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      promptOverhead += keys.reduce((acc, k) => acc + estimateTokens(k) + estimateTokens(q.criteria[k]!) + 6, 0);
      outputTokens += keys.length * 10 + 12;
    } else if (q.type === "score") {
      promptOverhead += q.criteria.reduce((acc, c) => acc + estimateTokens(c) + 6, 0);
      outputTokens += q.criteria.length * 8 + 12;
    } else {
      if (q.criteria?.true) promptOverhead += estimateTokens(q.criteria.true);
      if (q.criteria?.false) promptOverhead += estimateTokens(q.criteria.false);
      outputTokens += 12;
    }
  }
  return {
    inputTokens: estimateTokens(item.stateText) + promptOverhead,
    outputTokens,
  };
}

function computeDeterministicStructuredAnswers(
  stateText: string,
  questions: Record<string, DecisionQuestion>,
  questionIds: string[],
): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const qid of questionIds) {
    const q = questions[qid]!;
    if (q.type === "noul") {
      const trueLabel = [q.instructions, q.criteria?.true ?? ""].filter(Boolean).join(" ");
      const falseLabel = q.criteria?.false || "unrelated benign normal";
      const s = computeDeterministicScores(stateText, [trueLabel, falseLabel]);
      answers[qid] = { type: "noul", noul: clamp01(s[trueLabel] ?? 0.5) };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const labelByKey = keys.map((k) => `${k} ${q.criteria[k] ?? ""}`.trim());
      const rawScores = computeDeterministicScores(stateText, labelByKey, q.instructions);
      const probsArr = normalizeProbabilitiesArray(labelByKey.map((l) => rawScores[l] ?? 0));
      const probabilities: Record<string, number> = {};
      let bestChoice = keys[0]!;
      let bestProb = -1;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const p = probsArr[i]!;
        probabilities[key] = p;
        if (p > bestProb) {
          bestProb = p;
          bestChoice = key;
        }
      }
      answers[qid] = {
        type: "choice",
        choice: bestChoice,
        confidence: bestProb,
        probabilities,
      };
    } else {
      const levels = q.criteria.map((c, idx) => `${idx} ${c}`.trim());
      const rawScores = computeDeterministicScores(stateText, levels, q.instructions);
      const probabilities = normalizeProbabilitiesArray(levels.map((l) => rawScores[l] ?? 0));
      const score = Number(probabilities.reduce((acc, p, i) => acc + i * p, 0).toFixed(6));
      const confidence = Math.max(...probabilities);
      answers[qid] = { type: "score", score, confidence, probabilities };
    }
  }
  return answers;
}

function buildStructuredOutputSchema(
  questions: Record<string, DecisionQuestion>,
  questionIds: string[],
): Record<string, unknown> {
  const answerProps: Record<string, Record<string, unknown>> = {};
  for (const qid of questionIds) {
    const q = questions[qid]!;
    if (q.type === "noul") {
      answerProps[qid] = {
        type: "object",
        properties: {
          noul: { type: "number" },
        },
        required: ["noul"],
      };
    } else if (q.type === "choice") {
      const optionKeys = Object.keys(q.criteria);
      const optionProps: Record<string, Record<string, unknown>> = {};
      for (const opt of optionKeys) {
        optionProps[opt] = { type: "number" };
      }
      answerProps[qid] = {
        type: "object",
        properties: {
          probabilities: {
            type: "object",
            properties: optionProps,
            required: optionKeys,
          },
        },
        required: ["probabilities"],
      };
    } else {
      answerProps[qid] = {
        type: "object",
        properties: {
          probabilities: {
            type: "array",
            items: { type: "number" },
          },
        },
        required: ["probabilities"],
      };
    }
  }

  return {
    type: "object",
    properties: {
      answers: {
        type: "object",
        properties: answerProps,
        required: questionIds,
      },
    },
    required: ["answers"],
  };
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // Strip markdown fences if a provider ignores strict JSON formatting
    const stripped = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    if (!stripped) return null;
    try {
      const parsed = JSON.parse(stripped);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function normalizeStructuredAnswers(
  rawParsed: Record<string, unknown>,
  questions: Record<string, DecisionQuestion>,
  questionIds: string[],
): Record<string, DecisionAnswer> {
  const container = isPlainObject(rawParsed.answers) ? rawParsed.answers : rawParsed;
  const answers: Record<string, DecisionAnswer> = {};

  for (const qid of questionIds) {
    const q = questions[qid]!;
    const raw = container[qid];

    if (q.type === "noul") {
      let rawNum = NaN;
      if (typeof raw === "number") {
        rawNum = raw;
      } else if (isPlainObject(raw)) {
        const candidate = raw.noul ?? raw.probability ?? raw.value ?? raw.score;
        rawNum = Number(candidate);
      } else if (typeof raw === "boolean") {
        rawNum = raw ? 1 : 0;
      }
      const noul = Number.isFinite(rawNum) ? clamp01(rawNum) : 0.5;
      answers[qid] = { type: "noul", noul };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      let rawMap: Record<string, unknown> | null = null;
      let fallbackChoice: string | null = null;

      if (isPlainObject(raw)) {
        if (isPlainObject(raw.probabilities)) {
          rawMap = raw.probabilities;
        } else if (isPlainObject(raw.scores)) {
          rawMap = raw.scores;
        } else if (keys.some((k) => k in raw)) {
          rawMap = raw;
        }
        if (typeof raw.choice === "string" && keys.includes(raw.choice)) {
          fallbackChoice = raw.choice;
        }
      } else if (typeof raw === "string" && keys.includes(raw)) {
        fallbackChoice = raw;
      }

      let rawValues = keys.map((k) => {
        const v = Number(rawMap?.[k] ?? 0);
        return Number.isFinite(v) && v >= 0 ? v : 0;
      });
      if (rawValues.reduce((a, b) => a + b, 0) <= 0 && fallbackChoice) {
        rawValues = keys.map((k) =>
          k === fallbackChoice ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
        );
      }

      const normalized = normalizeProbabilitiesArray(rawValues);
      const probabilities: Record<string, number> = {};
      let bestChoice = keys[0]!;
      let bestProb = -1;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        const p = normalized[i]!;
        probabilities[key] = p;
        if (p > bestProb) {
          bestProb = p;
          bestChoice = key;
        }
      }
      answers[qid] = {
        type: "choice",
        choice: bestChoice,
        confidence: bestProb,
        probabilities,
      };
    } else {
      const len = q.criteria.length;
      let rawValues: number[] = new Array(len).fill(0);

      if (Array.isArray(raw)) {
        rawValues = Array.from({ length: len }, (_, i) => Number(raw[i] ?? 0));
      } else if (isPlainObject(raw)) {
        if (Array.isArray(raw.probabilities)) {
          rawValues = Array.from({ length: len }, (_, i) =>
            Number((raw.probabilities as unknown[])[i] ?? 0),
          );
        } else if (isPlainObject(raw.probabilities)) {
          const map = raw.probabilities;
          rawValues = Array.from({ length: len }, (_, i) => Number(map[String(i)] ?? 0));
        } else if (typeof raw.score === "number" && Number.isFinite(raw.score)) {
          const clamped = Math.max(0, Math.min(len - 1, raw.score));
          const lo = Math.floor(clamped);
          const hi = Math.ceil(clamped);
          if (lo === hi) {
            rawValues[lo] = 1;
          } else {
            rawValues[hi] = clamped - lo;
            rawValues[lo] = 1 - (clamped - lo);
          }
        }
      } else if (typeof raw === "number" && Number.isFinite(raw)) {
        const clamped = Math.max(0, Math.min(len - 1, raw));
        const lo = Math.floor(clamped);
        const hi = Math.ceil(clamped);
        if (lo === hi) {
          rawValues[lo] = 1;
        } else {
          rawValues[hi] = clamped - lo;
          rawValues[lo] = 1 - (clamped - lo);
        }
      }

      const probabilities = normalizeProbabilitiesArray(rawValues);
      const score = Number(probabilities.reduce((acc, p, i) => acc + i * p, 0).toFixed(6));
      const confidence = Math.max(...probabilities);
      answers[qid] = {
        type: "score",
        score,
        confidence,
        probabilities,
      };
    }
  }

  return answers;
}

const STRUCTURED_SYSTEM_PROMPT = [
  "You are a calibrated probabilistic decision engine. Evaluate the provided `state` against every question in `questions` independently and return ONLY valid JSON matching the output schema.",
  "Rules for `answers[questionId]`:",
  '- type "noul": return `{ "noul": p }` where `p` is the calibrated probability in [0, 1] that the statement/condition is true.',
  '- type "choice": return `{ "probabilities": { ... } }` containing a probability in [0, 1] for EVERY listed option key, summing to 1.0.',
  '- type "score": return `{ "probabilities": [...] }` as a JSON array of probabilities in [0, 1] whose length equals the number of `levels` (index 0 = lowest level), summing to 1.0.',
  "Use calibrated probabilities (e.g. 0.99 when clearly true, 0.50 when genuinely ambiguous). Do not include explanations or extra keys.",
].join("\n");

function formatQuestionsForPrompt(
  questions: Record<string, DecisionQuestion>,
  questionIds: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const qid of questionIds) {
    const q = questions[qid]!;
    if (q.type === "noul") {
      out[qid] = {
        type: "noul",
        instructions: q.instructions,
        ...(q.criteria ? { criteria: q.criteria } : {}),
      };
    } else if (q.type === "choice") {
      out[qid] = {
        type: "choice",
        instructions: q.instructions,
        options: q.criteria,
      };
    } else {
      out[qid] = {
        type: "score",
        instructions: q.instructions,
        levels: q.criteria.map((label, index) => ({ index, label })),
      };
    }
  }
  return out;
}

async function evaluateStructuredItem(params: {
  env: Env;
  tenantId: string;
  model: string;
  keyScope: string | null;
  prefetchedCredentials?: Record<string, ProviderCredentials | null>;
  item: ValidatedDecisionItem;
  signal?: AbortSignal;
}): Promise<{
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}> {
  const { env, tenantId, model, keyScope, prefetchedCredentials, item, signal } = params;
  const est = estimateStructuredItemTokens(item);
  let inputTokens = est.inputTokens;
  let outputTokens = est.outputTokens;
  let cacheReadTokens = 0;
  let answers: Record<string, DecisionAnswer>;

  if (model === "mock" || model.startsWith("mock/")) {
    answers = computeDeterministicStructuredAnswers(item.stateText, item.questions, item.questionIds);
  } else {
    const outputSchema = buildStructuredOutputSchema(item.questions, item.questionIds);
    const userPayload = JSON.stringify({
      questions: formatQuestionsForPrompt(item.questions, item.questionIds),
      state: item.stateForPrompt,
    });

    let rawText = "";
    for await (const chunk of streamPiModel({
      env,
      tenantId,
      model,
      keyScope,
      prefetchedCredentials,
      instructions: STRUCTURED_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPayload, timestamp: Date.now() }],
      outputSchema,
      ...(isReasoningModel(model) ? {} : { temperature: 0 }),
      signal,
    })) {
      if (chunk.type === "text_delta") {
        rawText += chunk.delta;
      } else if (chunk.type === "done") {
        inputTokens = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
        cacheReadTokens = chunk.cacheReadTokens ?? 0;
      }
    }

    const parsed = parseJsonObject(rawText);
    if (!parsed) {
      throw new ApiError(502, "decision_failed", "Decision model returned invalid JSON");
    }
    answers = normalizeStructuredAnswers(parsed, item.questions, item.questionIds);
  }

  const costUsd = calculateCostUsd(model, inputTokens, outputTokens, 0, cacheReadTokens);
  return { answers, inputTokens, outputTokens, cacheReadTokens, costUsd };
}

async function resolveProviderContext(
  env: Env,
  tenantId: string,
  model: string,
  keyScope: string | null,
): Promise<{
  isByok: boolean;
  prefetchedCredentials?: Record<string, ProviderCredentials | null>;
}> {
  const ref = parsePiModelRef(model, env);
  if (ref.provider === "mock") {
    return { isByok: false };
  }
  const resolved = await resolveTenantByokProvider(env, tenantId, model, undefined, keyScope);
  return {
    isByok: resolved.isByok,
    prefetchedCredentials: {
      [ref.provider]: resolved.prefetchedProvider?.credentials ?? null,
    },
  };
}

async function settleDecisionUsage(params: {
  env: Env;
  tenantId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  actor?: string;
  isByok: boolean;
}): Promise<void> {
  const { env, tenantId, model, inputTokens, outputTokens, cacheReadTokens, costUsd, actor, isByok } =
    params;
  if (costUsd <= 0 && inputTokens <= 0 && outputTokens <= 0) return;
  await getTenantStub(env, tenantId)
    .settleUsage({
      refId: `dec:${randomId("d", 8)}`,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      vmMs: 0,
      costUsd,
      note: "POST /v2/decisions",
      ...(actor ? { actor } : {}),
      ...(isByok ? { byok: true } : {}),
    })
    .catch(() => {});
}

async function runLegacyDecisionClassifier(
  env: Env,
  tenantId: string,
  req: DecisionRequest,
  signal?: AbortSignal,
): Promise<DecisionResponse> {
  if (typeof req.input !== "string" || !req.input.trim()) {
    throw new ApiError(400, "invalid_request", "`input` must be a non-empty string");
  }
  if (!Array.isArray(req.choices) || req.choices.length === 0) {
    throw new ApiError(400, "invalid_request", "`choices` must be a non-empty array of strings");
  }
  const choices = req.choices.map((c) => String(c).trim()).filter(Boolean);
  if (choices.length === 0) {
    throw new ApiError(400, "invalid_request", "`choices` must contain at least one valid string");
  }

  const { keyScope, actor, maxUsd } = validateCommonOptions(req);
  const model = resolveDecisionModel(env, req.model);
  let scores: Record<string, number>;
  let inputTokens = estimateTokens(req.input) + estimateTokens(req.instructions ?? "");
  let outputTokens = 16;
  let cacheReadTokens = 0;

  if (maxUsd !== undefined) {
    const estimated = calculateCostUsd(model, inputTokens, outputTokens);
    if (estimated > maxUsd) {
      throw new ApiError(402, "spend_limit", "Estimated decision cost exceeds `maxUsd`");
    }
  }

  const { isByok, prefetchedCredentials } = await resolveProviderContext(env, tenantId, model, keyScope);

  if (model === "mock" || model.startsWith("mock/")) {
    scores = computeDeterministicScores(req.input, choices, req.instructions);
  } else {
    const props: Record<string, Record<string, unknown>> = {};
    for (const c of choices) {
      props[c] = { type: "number" };
    }
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        choice: { type: "string", enum: choices },
        scores: {
          type: "object",
          properties: props,
          required: choices,
        },
      },
      required: ["choice", "scores"],
    };

    let rawText = "";
    for await (const chunk of streamPiModel({
      env,
      tenantId,
      model,
      keyScope,
      prefetchedCredentials,
      instructions: [
        req.instructions || "Classify the input into exactly one of the allowed choices.",
        `Allowed choices: ${JSON.stringify(choices)}. Return calibrated probabilities summing to 1.0 in 'scores'.`,
      ].join("\n"),
      messages: [{ role: "user", content: req.input, timestamp: Date.now() }],
      outputSchema: schema,
      ...(isReasoningModel(model) ? {} : { temperature: 0 }),
      signal,
    })) {
      if (chunk.type === "text_delta") {
        rawText += chunk.delta;
      } else if (chunk.type === "done") {
        inputTokens = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
        cacheReadTokens = chunk.cacheReadTokens ?? 0;
      }
    }

    const parsed = parseJsonObject(rawText) as {
      choice?: string;
      scores?: Record<string, unknown>;
    } | null;
    if (parsed?.scores && isPlainObject(parsed.scores)) {
      scores = normalizeScoreMap(parsed.scores, choices);
    } else if (parsed?.choice && choices.includes(parsed.choice)) {
      const raw: Record<string, number> = {};
      for (const c of choices) {
        raw[c] = c === parsed.choice ? 0.9 : 0.1 / Math.max(1, choices.length - 1);
      }
      scores = normalizeScoreMap(raw, choices);
    } else {
      scores = computeDeterministicScores(req.input, choices, req.instructions);
    }
  }

  let bestChoice = choices[0]!;
  let bestScore = -1;
  for (const c of choices) {
    const s = scores[c] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestChoice = c;
    }
  }

  const costUsd = calculateCostUsd(model, inputTokens, outputTokens, 0, cacheReadTokens);
  await settleDecisionUsage({
    env,
    tenantId,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd,
    actor,
    isByok,
  });

  return {
    choice: bestChoice,
    confidence: bestScore,
    scores,
    costUsd,
  };
}

async function runStructuredDecision(
  env: Env,
  tenantId: string,
  req: StructuredDecisionRequest,
  signal?: AbortSignal,
): Promise<StructuredDecisionResponse> {
  const startedAt = Date.now();
  const { keyScope, actor, maxUsd } = validateCommonOptions(req);
  const model = resolveDecisionModel(env, req.model);
  const item = validateDecisionItem(req);

  if (maxUsd !== undefined) {
    const est = estimateStructuredItemTokens(item);
    const estimated = calculateCostUsd(model, est.inputTokens, est.outputTokens);
    if (estimated > maxUsd) {
      throw new ApiError(402, "spend_limit", "Estimated decision cost exceeds `maxUsd`");
    }
  }

  const { isByok, prefetchedCredentials } = await resolveProviderContext(env, tenantId, model, keyScope);
  const out = await evaluateStructuredItem({
    env,
    tenantId,
    model,
    keyScope,
    prefetchedCredentials,
    item,
    signal,
  });

  await settleDecisionUsage({
    env,
    tenantId,
    model,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    cacheReadTokens: out.cacheReadTokens,
    costUsd: out.costUsd,
    actor,
    isByok,
  });

  return {
    model,
    answers: out.answers,
    usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens },
    costUsd: out.costUsd,
    ms: Date.now() - startedAt,
  };
}

async function runStructuredBatchDecision(
  env: Env,
  tenantId: string,
  req: StructuredDecisionBatchRequest,
  signal?: AbortSignal,
): Promise<StructuredDecisionBatchResponse> {
  const startedAt = Date.now();
  if ("state" in req || "questions" in req) {
    throw new ApiError(
      400,
      "invalid_request",
      "Specify either `items` or `state` + `questions`, not both",
    );
  }
  if (!Array.isArray(req.items) || req.items.length === 0) {
    throw new ApiError(400, "invalid_request", "`items` must be a non-empty array");
  }
  if (req.items.length > MAX_BATCH_ITEMS) {
    throw new ApiError(
      400,
      "invalid_request",
      `\`items\` may contain at most ${MAX_BATCH_ITEMS} items`,
    );
  }

  const { keyScope, actor, maxUsd } = validateCommonOptions(req);
  const model = resolveDecisionModel(env, req.model);

  if (maxUsd !== undefined) {
    let estInput = 0;
    let estOutput = 0;
    for (const rawItem of req.items) {
      try {
        const validated = validateDecisionItem(rawItem);
        const est = estimateStructuredItemTokens(validated);
        estInput += est.inputTokens;
        estOutput += est.outputTokens;
      } catch {
        // Invalid items will return per-item errors and are not billed
      }
    }
    const estimated = calculateCostUsd(model, estInput, estOutput);
    if (estimated > maxUsd) {
      throw new ApiError(402, "spend_limit", "Estimated decision batch cost exceeds `maxUsd`");
    }
  }

  const { isByok, prefetchedCredentials } = await resolveProviderContext(env, tenantId, model, keyScope);

  const results = new Array<StructuredBatchItemResult>(req.items.length);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCostUsd = 0;

  let nextIdx = 0;
  const workerCount = Math.min(BATCH_CONCURRENCY, req.items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= req.items.length) break;
      if (signal?.aborted) {
        results[idx] = { error: { message: "Request was aborted" } };
        continue;
      }
      try {
        const validated = validateDecisionItem(req.items[idx]);
        const evaluated = await evaluateStructuredItem({
          env,
          tenantId,
          model,
          keyScope,
          prefetchedCredentials,
          item: validated,
          signal,
        });
        totalInputTokens += evaluated.inputTokens;
        totalOutputTokens += evaluated.outputTokens;
        totalCacheReadTokens += evaluated.cacheReadTokens;
        totalCostUsd += evaluated.costUsd;
        results[idx] = {
          answers: evaluated.answers,
          usage: {
            inputTokens: evaluated.inputTokens,
            outputTokens: evaluated.outputTokens,
          },
          costUsd: evaluated.costUsd,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[idx] = { error: { message } };
      }
    }
  });

  await Promise.all(workers);

  const roundedCostUsd = Number(totalCostUsd.toFixed(8));
  await settleDecisionUsage({
    env,
    tenantId,
    model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    costUsd: roundedCostUsd,
    actor,
    isByok,
  });

  return {
    model,
    results,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    costUsd: roundedCostUsd,
    ms: Date.now() - startedAt,
  };
}

export async function runDecisionClassifier(
  env: Env,
  tenantId: string,
  req: DecisionEndpointRequest,
  signal?: AbortSignal,
): Promise<DecisionEndpointResponse> {
  if (!isPlainObject(req)) {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
  if ("items" in req && req.items !== undefined) {
    return runStructuredBatchDecision(env, tenantId, req as StructuredDecisionBatchRequest, signal);
  }
  if (("state" in req && req.state !== undefined) || ("questions" in req && req.questions !== undefined)) {
    return runStructuredDecision(env, tenantId, req as StructuredDecisionRequest, signal);
  }
  return runLegacyDecisionClassifier(env, tenantId, req as DecisionRequest, signal);
}
