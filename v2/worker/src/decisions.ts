import { randomId } from "./crypto.ts";
import { calculateCostUsd, streamModelResponse } from "./providers.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, estimateTokens, type Env } from "./types.ts";

export interface DecisionRequest {
  input: string;
  choices: string[];
  instructions?: string;
  model?: string;
}

export interface DecisionResponse {
  choice: string;
  confidence: number;
  scores: Record<string, number>;
  costUsd: number;
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1);
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
          if (iw.length >= 4 && tok.length >= 4 && (iw.startsWith(tok.slice(0, 4)) || tok.startsWith(iw.slice(0, 4)))) {
            logit += 1.1;
          }
        }
      }
    }
    return logit;
  });

  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sumExp = exps.reduce((a, b) => a + b, 0) || 1;

  const scores: Record<string, number> = {};
  for (let i = 0; i < choices.length; i++) {
    scores[choices[i]!] = Number((exps[i]! / sumExp).toFixed(6));
  }
  return scores;
}

function normalizeScoreMap(
  raw: Record<string, unknown>,
  choices: string[],
): Record<string, number> {
  const positive: number[] = choices.map((c) => {
    const val = Number(raw[c] ?? 0);
    return Number.isFinite(val) && val >= 0 ? val : 0;
  });
  const total = positive.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (total <= 0) {
    const uniform = Number((1 / choices.length).toFixed(6));
    for (const c of choices) out[c] = uniform;
    return out;
  }
  for (let i = 0; i < choices.length; i++) {
    out[choices[i]!] = Number((positive[i]! / total).toFixed(6));
  }
  return out;
}

export async function runDecisionClassifier(
  env: Env,
  tenantId: string,
  req: DecisionRequest,
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

  const model = (req.model || env.DEFAULT_MODEL || "openrouter/meta/muse-ember").trim();
  let scores: Record<string, number>;
  let inputTokens = estimateTokens(req.input) + estimateTokens(req.instructions ?? "");
  let outputTokens = 16;

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
    for await (const chunk of streamModelResponse({
      env,
      tenantId,
      model,
      instructions: [
        req.instructions || "Classify the input into exactly one of the allowed choices.",
        `Allowed choices: ${JSON.stringify(choices)}. Return calibrated probabilities summing to 1.0 in 'scores'.`,
      ].join("\n"),
      messages: [{ role: "user", text: req.input }],
      outputSchema: schema,
      temperature: 0,
      purpose: "decision",
    })) {
      if (chunk.type === "text_delta") {
        rawText += chunk.delta;
      } else if (chunk.type === "done") {
        inputTokens = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
      }
    }

    try {
      const parsed = JSON.parse(rawText) as {
        choice?: string;
        scores?: Record<string, unknown>;
      };
      if (parsed.scores && typeof parsed.scores === "object") {
        scores = normalizeScoreMap(parsed.scores, choices);
      } else if (parsed.choice && choices.includes(parsed.choice)) {
        const raw: Record<string, number> = {};
        for (const c of choices) raw[c] = c === parsed.choice ? 0.9 : 0.1 / Math.max(1, choices.length - 1);
        scores = normalizeScoreMap(raw, choices);
      } else {
        scores = computeDeterministicScores(req.input, choices, req.instructions);
      }
    } catch {
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

  const costUsd = calculateCostUsd(model, inputTokens, outputTokens, 0);
  if (costUsd > 0 || inputTokens > 0) {
    await getTenantStub(env, tenantId)
      .settleUsage({
        refId: `dec:${randomId("d", 8)}`,
        model,
        inputTokens,
        outputTokens,
        vmMs: 0,
        costUsd,
        note: "POST /v2/decisions",
      })
      .catch(() => {});
  }

  return {
    choice: bestChoice,
    confidence: bestScore,
    scores,
    costUsd,
  };
}
