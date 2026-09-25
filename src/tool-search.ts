import { createHash } from "node:crypto";
import type { ToolDefinition } from "../shared/client-protocol.ts";

/**
 * `tools.search` in js_exec. Keyword ranking always runs, needs nothing, and is the answer
 * whenever no reranker is configured or every one fails. Rerankers order tools by meaning, in
 * stages: each sees the whole catalog if it can take that many candidates (embeddings can),
 * else the best of the order so far. Keywords miss synonyms ("money back" for refund_payment),
 * so a stage that cannot see everything should follow one that can: `embeddings,jev`.
 * The stages' orders and the keyword order are fused (reciprocal rank fusion).
 */

export type SearchQuery = { query?: string; namespace?: string; limit?: number };
export type SearchHit = { name: string; description: string };
export type Candidate = { name: string; description: string };

/** Orders candidates by relevance to a query: a score per candidate, higher is better. */
export interface Reranker {
  readonly kind: string;
  /** The most candidates one call takes; more are cut to the best of the order so far. */
  readonly maxCandidates: number;
  rerank(query: string, candidates: Candidate[], signal: AbortSignal): Promise<number[]>;
  /** Index a catalog ahead of its first search (embeddings embed its tools); failures are ignored. */
  warm?(candidates: Candidate[]): void;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 128;
/** All rerank stages of one search get this long; a stage not done by then is left out. */
export const RERANK_TIMEOUT_MS = 2_500;
/** Candidates a stage that cannot see the whole catalog is given. */
export const STAGE_CANDIDATES = 100;
const DESCRIPTION_CHARS = 300;

/** A search from code: a string, or `{ query, namespace, limit }`. */
export function searchQuery(value: unknown): SearchQuery {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") return { query: value };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("tools.search takes a query string or { query?, namespace?, limit? }");
  const { query, namespace, limit } = value as Record<string, unknown>;
  if (query !== undefined && typeof query !== "string") throw new Error("tools.search query must be a string");
  if (namespace !== undefined && typeof namespace !== "string") throw new Error("tools.search namespace must be a string");
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) throw new Error("tools.search limit must be a positive integer");
  return { ...(query !== undefined ? { query } : {}), ...(namespace !== undefined ? { namespace } : {}), ...(limit !== undefined ? { limit: Math.min(limit as number, MAX_LIMIT) } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Keyword ranking, after Executor's: fields weighted, words matched exactly, by prefix or inside,
// a bonus for matching every word. Unlike Executor it keeps partial matches (ranked below full
// ones): with a catalog this small, a miss costs more than a weak result.

const WEIGHTS = { name: 10, namespace: 8, description: 5 };

const normalize = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_./:-]+/g, " ").toLowerCase().trim();

/** A crude stem, so "files", "filed" and "filing" meet "file". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
const STOPWORDS = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "at", "by", "and", "or", "is", "are", "be", "it", "its", "my", "me", "i", "with", "from", "into", "that", "this", "some", "any", "all"]);
const words = (value: string) => normalize(value).split(/[^a-z0-9]+/).filter(word => word && !STOPWORDS.has(word)).map(stem);

/** The source a tool comes from: what precedes `__` in its name (an MCP server or OpenAPI source). */
export const namespaceOf = (name: string) => name.includes("__") ? name.slice(0, name.indexOf("__")) : "";
const ownName = (name: string) => name.includes("__") ? name.slice(name.indexOf("__") + 2) : name;

type Field = { raw: string; words: string[] };
const field = (value: string): Field => ({ raw: normalize(value), words: words(value) });

function fieldScore(phrase: string, queryWords: string[], target: Field, weight: number, matched: Set<string>) {
  if (!target.raw) return 0;
  let score = 0;
  if (phrase) {
    if (target.raw === phrase) score += weight * 14;
    else if (target.raw.startsWith(phrase)) score += weight * 9;
    else if (target.raw.includes(phrase)) score += weight * 6;
  }
  for (const word of queryWords) {
    if (target.words.includes(word)) { score += weight * 4; matched.add(word); }
    else if (target.words.some(candidate => Math.min(candidate.length, word.length) >= 3 && (candidate.startsWith(word) || word.startsWith(candidate)))) { score += weight * 2; matched.add(word); }
    else if (word.length < 3) continue;
    else if (target.raw.includes(word)) { score += weight; matched.add(word); }
  }
  return score;
}

type Prepared = { name: Field; namespace: Field; description: Field; full: string };
/** Tools' normalized fields, kept per tool object: a large catalog is searched many times. */
const prepared = new WeakMap<object, Prepared>();
function prepare(tool: Candidate): Prepared {
  let fields = prepared.get(tool);
  if (!fields) prepared.set(tool, fields = { name: field(ownName(tool.name)), namespace: field(namespaceOf(tool.name)), description: field(tool.description), full: normalize(tool.name) });
  return fields;
}

/** A keyword score for each tool; 0 means no query word matched. */
export function keywordScores(tools: Candidate[], query: string): number[] {
  const phrase = normalize(query);
  const queryWords = [...new Set(words(query))];
  if (!queryWords.length) return tools.map(() => 0);
  return tools.map(tool => {
    const matched = new Set<string>();
    const { name, namespace, description, full } = prepare(tool);
    let score = fieldScore(phrase, queryWords, name, WEIGHTS.name, matched)
      + fieldScore(phrase, queryWords, namespace, WEIGHTS.namespace, matched)
      + fieldScore(phrase, queryWords, description, WEIGHTS.description, matched);
    if (!matched.size) return 0;
    score += matched.size === queryWords.length ? 25 : Math.round(10 * matched.size / queryWords.length);
    if (name.words[0] === queryWords[0]) score += 8;
    if (name.raw === phrase || full === phrase) score += 20;
    return score;
  });
}

// ---------------------------------------------------------------------------------------------

const hit = (tool: Candidate): SearchHit => ({
  name: tool.name, description: tool.description.length > DESCRIPTION_CHARS ? `${tool.description.slice(0, DESCRIPTION_CHARS - 1)}…` : tool.description,
});

/** Positions from scores, best first; ties keep catalog order. Entries at or below `floor` get no rank. */
function ranks(scores: number[], floor = -Infinity): Map<number, number> {
  const order = scores.map((score, index) => ({ score, index })).filter(entry => entry.score > floor).sort((a, b) => b.score - a.score || a.index - b.index);
  return new Map(order.map((entry, rank) => [entry.index, rank]));
}

/** The catalog's sources (what precedes `__` in tool names) and how many tools each has. */
export function namespaces(tools: Candidate[]): { namespace: string; tools: number }[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(namespaceOf(tool.name), (counts.get(namespaceOf(tool.name)) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([namespace, count]) => ({ namespace, tools: count }));
}

const K = 60;
const fuse = (signals: Map<number, number>[], size: number) =>
  Array.from({ length: size }, (_, index) => signals.reduce((sum, signal) => sum + (signal.has(index) ? 1 / (K + signal.get(index)!) : 0), 0));

/**
 * Search a catalog. An empty query lists it (in a namespace, if given), in catalog order. A query
 * ranks it by keywords, then by each reranker stage in turn, fusing the orders; a stage that fails
 * or runs out of time is left out. Without rerankers only tools some query word matches come back.
 */
export async function searchTools(tools: Candidate[], search: SearchQuery, options: { rerankers?: Reranker[]; signal?: AbortSignal; timeoutMs?: number; onError?: (error: unknown, reranker: Reranker) => void } = {}): Promise<SearchHit[]> {
  const namespace = search.namespace?.trim();
  const pool = namespace ? tools.filter(tool => namespaceOf(tool.name) === namespace || tool.name === namespace) : tools;
  const query = search.query?.trim() ?? "";
  if (!words(query).length) return pool.slice(0, search.limit ?? MAX_LIMIT).map(hit);
  const limit = search.limit ?? DEFAULT_LIMIT;
  const signals = [ranks(keywordScores(pool, query), 0)];
  const stages = pool.length > 1 ? options.rerankers ?? [] : [];
  if (stages.length) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("tool search reranking timed out")), options.timeoutMs ?? RERANK_TIMEOUT_MS);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      for (const stage of stages) {
        if (controller.signal.aborted) break;
        // The whole pool if the stage takes it; else the best so far, catalog order after the matches.
        let chosen = pool.map((_, index) => index);
        if (pool.length > stage.maxCandidates) {
          const order = ranks(fuse(signals, pool.length), 0);
          const best = [...order.entries()].sort((a, b) => a[1] - b[1]).map(([index]) => index);
          const seen = new Set(best);
          chosen = [...best, ...chosen.filter(index => !seen.has(index))].slice(0, stage.maxCandidates);
        }
        try {
          const scores = await stage.rerank(query, chosen.map(index => pool[index]), controller.signal);
          if (scores.length !== chosen.length || scores.some(score => typeof score !== "number" || Number.isNaN(score))) throw new Error(`${stage.kind} returned ${scores.length} scores for ${chosen.length} tools`);
          const order = ranks(scores);
          signals.push(new Map([...order].map(([position, rank]) => [chosen[position], rank])));
        } catch (error) {
          options.signal?.throwIfAborted();
          options.onError?.(error, stage);
        }
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  return [...ranks(fuse(signals, pool.length), 0).entries()].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([index]) => hit(pool[index]));
}

// ---------------------------------------------------------------------------------------------
// Rerankers. Configured by the operator (AGENT_TOOL_SEARCH), not per tenant.

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** A bounded map that forgets the least recently used entry. */
class Lru<V> {
  private entries = new Map<string, V>();
  private readonly size: number;
  constructor(size: number) { this.size = size; }
  get(key: string) {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
  }
}

async function post(url: string, apiKey: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Embeddings from an OpenAI-compatible `/embeddings` endpoint (OpenRouter, OpenAI, a local server).
 * Tool texts are embedded once and cached by content, so a search usually embeds only its query.
 */
export function embeddingReranker(options: { url: string; apiKey: string; model: string; cacheSize?: number }): Reranker {
  const cache = new Lru<number[]>(options.cacheSize ?? 20_000);
  const key = (text: string) => createHash("sha256").update(`${options.model}\0${text}`).digest("base64url");
  async function embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    const missing = [...new Set(texts.filter(text => !cache.get(key(text))))];
    const batches: string[][] = [];
    for (let start = 0; start < missing.length; start += 256) batches.push(missing.slice(start, start + 256));
    // A few at a time: a catalog of thousands embeds in a second or two, without flooding the provider.
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
      for (let batch = batches.shift(); batch; batch = batches.shift()) await embedBatch(batch, signal);
    }));
    return texts.map(text => cache.get(key(text))!);
  }
  async function embedBatch(batch: string[], signal: AbortSignal) {
    const json = await post(endpoint(options.url, "embeddings"), options.apiKey, { model: options.model, input: batch }, signal);
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== batch.length) throw new Error("The embeddings endpoint returned an unexpected shape");
    for (const entry of data) {
      const vector = entry?.embedding;
      if (!Array.isArray(vector) || typeof entry.index !== "number") throw new Error("The embeddings endpoint returned an unexpected shape");
      cache.set(key(batch[entry.index]), vector);
    }
  }
  return {
    kind: "embeddings", maxCandidates: Infinity,
    warm(candidates) { void embed(candidates.map(toolText), AbortSignal.timeout(120_000)).catch(() => {}); },
    async rerank(query, candidates, signal) {
      const [queryVector, ...vectors] = await embed([query, ...candidates.map(toolText)], signal);
      return vectors.map(vector => cosine(queryVector, vector));
    },
  };
}

const toolText = (tool: Candidate) => `${tool.name.replaceAll("__", " ").replaceAll("_", " ")}: ${tool.description}`;
const endpoint = (base: string, path: string) => `${base.replace(/\/$/, "")}/${path}`;

/** A reranking model behind a Cohere-style `/rerank` endpoint (OpenRouter serves Cohere's): relevance per tool. */
export function rerankModel(options: { url: string; apiKey: string; model: string }): Reranker {
  return {
    kind: "rerank", maxCandidates: STAGE_CANDIDATES,
    async rerank(query, candidates, signal) {
      const json = await post(endpoint(options.url, "rerank"), options.apiKey, { model: options.model, query, documents: candidates.map(toolText) }, signal);
      if (!Array.isArray(json?.results)) throw new Error("The rerank endpoint returned no results");
      const scores = candidates.map(() => 0);
      for (const result of json.results) if (Number.isInteger(result?.index) && result.index < scores.length) scores[result.index] = Number(result.relevance_score);
      return scores;
    },
  };
}

/**
 * Jev (TypeSafe's decision model), directly or through OpenRouter's `/systemone`: one Choice over the
 * whole catalog, each tool an option with its description as the rubric; the option probabilities
 * are the order. Choices take at most 255 options.
 */
export function jevReranker(options: { url: string; apiKey: string; model: string }): Reranker {
  return {
    kind: "jev", maxCandidates: STAGE_CANDIDATES,
    async rerank(query, candidates, signal) {
      if (candidates.length > 255) throw new Error("Jev choices take at most 255 options");
      const criteria = Object.fromEntries(candidates.map(tool => [tool.name, tool.description.slice(0, 1_000) || null]));
      const json = await post(endpoint(options.url, "systemone"), options.apiKey, {
        model: options.model, state: query,
        questions: { tool: { type: "choice", instructions: "The state is what an agent is searching its tools for. Which tool is the best fit?", criteria } },
      }, signal);
      const probabilities = json?.answers?.tool?.probabilities;
      if (!probabilities || typeof probabilities !== "object") throw new Error("Jev returned no probabilities");
      return candidates.map(tool => Number(probabilities[tool.name] ?? 0));
    },
  };
}

const DEFAULT_MODELS: Record<string, string> = { embeddings: "openai/text-embedding-3-small", rerank: "cohere/rerank-4-fast", jev: "typesafe/jev-1.13" };

/**
 * The operator's rerank stages, from the environment. AGENT_TOOL_SEARCH is `keyword` (the default:
 * none), or stages in order, comma-separated, from `embeddings`, `rerank` (a Cohere-style reranking
 * model) and `jev`: `embeddings,jev` finds candidates by meaning across any catalog, then lets Jev
 * order the best hundred. All speak to OpenRouter by default (AGENT_TOOL_SEARCH_URL,
 * https://openrouter.ai/api/v1) with AGENT_TOOL_SEARCH_API_KEY; the URL may be any compatible API.
 * AGENT_TOOL_SEARCH_<STAGE>_MODEL overrides a stage's model (defaults: openai/text-embedding-3-small,
 * cohere/rerank-4-fast, typesafe/jev-1.13).
 */
export function rerankersFromEnv(env: Record<string, string | undefined> = process.env): Reranker[] {
  const kinds = (env.AGENT_TOOL_SEARCH?.trim() || "keyword").split(",").map(kind => kind.trim()).filter(Boolean);
  if (kinds.length === 1 && kinds[0] === "keyword") return [];
  for (const kind of kinds) if (!(kind in DEFAULT_MODELS)) throw new Error(`AGENT_TOOL_SEARCH must be keyword, or stages from embeddings, rerank and jev; not ${kind}`);
  if (new Set(kinds).size !== kinds.length) throw new Error("AGENT_TOOL_SEARCH names a stage twice");
  const apiKey = env.AGENT_TOOL_SEARCH_API_KEY;
  if (!apiKey) throw new Error(`AGENT_TOOL_SEARCH=${kinds.join(",")} needs AGENT_TOOL_SEARCH_API_KEY`);
  const url = env.AGENT_TOOL_SEARCH_URL || "https://openrouter.ai/api/v1";
  return kinds.map(kind => {
    const settings = { url, apiKey, model: env[`AGENT_TOOL_SEARCH_${kind.toUpperCase()}_MODEL`] || DEFAULT_MODELS[kind] };
    return kind === "embeddings" ? embeddingReranker(settings) : kind === "rerank" ? rerankModel(settings) : jevReranker(settings);
  });
}
