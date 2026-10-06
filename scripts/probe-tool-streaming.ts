// Measures which catalog models stream tool-call arguments as they are written (many toolcall_delta events spread over
// time) and which deliver them in one piece (Gemini and GLM on OpenRouter, for example), and records the verdicts in
// src/tool-streaming.json, which GET /v1/models reads as `toolCallStreaming`. A model not measured stays "unknown".
//
// Each probe is one small call through the same path the runtime uses (explicitKeyStream, the model as resolveModel
// gives it, the least reasoning the model allows): the model is asked to call write_section with a ~80-word body.
//
// A gateway may route one model to several hosts that differ (OpenRouter's openai/gpt-5-mini streamed on one probe and
// came in one piece on the next), so `true` means every one of --samples probes streamed: a model that sent its
// arguments in one piece even once is `false`, since an app cannot count on it. Probing stops at the first such sample.
//
//   node --experimental-strip-types scripts/probe-tool-streaming.ts [--providers openrouter,anthropic,openai]
//     [--only provider/model,...] [--samples 3] [--budget 1.5] [--max-call 0.05] [--concurrency 8] [--dry-run]
//
// Keys: the platform keys (platformKeys.<provider>) from the tenants file named by AGENT_TENANTS_FILE, or else from the
// Secrets Manager secret named by --secret (default camelai/agent-runtime/tenants). They are held in memory only and
// never printed or written. Spend: --budget caps the measured cost (USD) of the whole run, and a model whose worst case
// (prompt + max tokens at its catalog price) exceeds --max-call is skipped and stays unknown.
import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { listModels } from "../src/catalog.ts";
import { explicitKeyStream } from "../src/compaction.ts";
import { reasoningFloor } from "../src/pi-catalog.ts";
import { resolveModel } from "../src/session-config.ts";

const OUT = new URL("../src/tool-streaming.json", import.meta.url).pathname;
const MAX_TOKENS = 1_500;
const PROMPT_TOKENS = 300;
const TIMEOUT_MS = 90_000;

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const providers = flag("providers", "openrouter,anthropic,openai")!.split(",");
const only = flag("only")?.split(",");
const budget = Number(flag("budget", "1.5"));
const maxCall = Number(flag("max-call", "0.05"));
const concurrency = Number(flag("concurrency", "8"));
const samples = Number(flag("samples", "3"));
const dryRun = args.includes("--dry-run");

async function platformKeys(): Promise<Record<string, string>> {
  const file = process.env.AGENT_TENANTS_FILE;
  if (file) return JSON.parse(readFileSync(file, "utf8")).platformKeys ?? {};
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: flag("secret", "camelai/agent-runtime/tenants") }));
  return JSON.parse(secret.SecretString ?? "{}").platformKeys ?? {};
}

const context: Context = {
  systemPrompt: "You write sections of a page by calling write_section. Never answer in plain text.",
  messages: [{ role: "user", content: "Call write_section once: heading \"Lighthouses\", and a body of about 80 words on how lighthouses guided ships. Write nothing else.", timestamp: Date.now() }],
  tools: [{
    name: "write_section", description: "Write one section of the page.",
    parameters: Type.Object({ heading: Type.String(), body: Type.String({ description: "The section text, about 80 words" }) }),
  }],
};

export type Verdict = { streams: boolean | "unknown"; deltas: number; spreadMs: number; argChars: number; cost: number; note?: string };

/** Several samples' verdicts as one: any sample in one piece is false; otherwise true if any streamed, else unknown. */
export function combine(verdicts: (boolean | "unknown")[]): boolean | "unknown" {
  return verdicts.includes(false) ? false : verdicts.includes(true) ? true : "unknown";
}

/**
 * Streams when the arguments came as at least 3 pieces spread over at least 100 ms; one piece, or everything inside
 * 20 ms (a provider replaying a buffered call), is not streaming. Anything between is left unknown.
 */
export function classify(deltas: number, spreadMs: number): boolean | "unknown" {
  if (deltas <= 2 || spreadMs < 20) return false;
  if (deltas >= 3 && spreadMs >= 100) return true;
  return "unknown";
}

async function probe(model: Model<Api>, apiKey: string): Promise<Verdict> {
  const floor = reasoningFloor(model);
  const stream = await explicitKeyStream()(model, context as never, { apiKey, maxTokens: MAX_TOKENS, reasoning: floor, signal: AbortSignal.timeout(TIMEOUT_MS) } as never);
  const times: number[] = [];
  let index: number | undefined;
  let argChars = 0;
  let final: AssistantMessage | undefined;
  let error: string | undefined;
  for await (const event of stream) {
    if (event.type === "toolcall_start" && index === undefined) index = event.contentIndex;
    else if (event.type === "toolcall_delta" && event.contentIndex === index && event.delta) { times.push(performance.now()); argChars += event.delta.length; }
    else if (event.type === "done") final = event.message;
    else if (event.type === "error") { final = event.error; error = event.error.errorMessage ?? "error"; }
  }
  const cost = final?.usage?.cost?.total ?? 0;
  const spreadMs = times.length ? Math.round(times[times.length - 1] - times[0]) : 0;
  if (error) return { streams: "unknown", deltas: times.length, spreadMs, argChars, cost, note: error.slice(0, 160) };
  const call = final?.content.find(block => block.type === "toolCall");
  if (!call || index === undefined) return { streams: "unknown", deltas: 0, spreadMs: 0, argChars: 0, cost, note: "no tool call" };
  // The arguments must be long enough to have been streamed at all.
  if (JSON.stringify(call.arguments).length < 200) return { streams: "unknown", deltas: times.length, spreadMs, argChars, cost, note: "arguments too short to tell" };
  return { streams: classify(times.length, spreadMs), deltas: times.length, spreadMs, argChars, cost };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = dryRun ? {} : await platformKeys();
  const worst = (model: { cost: { input: number; output: number } }) => (PROMPT_TOKENS * Math.max(0, model.cost.input) + MAX_TOKENS * Math.max(0, model.cost.output)) / 1e6;
  const candidates = providers.flatMap(provider => listModels(provider))
    .filter(model => !only || only.includes(model.id))
    // A router (negative catalog price: OpenRouter's auto) answers with whichever model it picks: not one model's behavior.
    .filter(model => model.cost.input >= 0 && model.cost.output >= 0);
  const skipped = candidates.filter(model => worst(model) > maxCall);
  const queue = candidates.filter(model => worst(model) <= maxCall);
  console.log(`${queue.length} models to probe, ${skipped.length} over $${maxCall} worst case (left unknown); budget $${budget}; worst case total $${queue.reduce((sum, model) => sum + worst(model), 0).toFixed(2)}`);
  if (dryRun) process.exit(0);

  const existing = (() => { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return { models: {} }; } })();
  const results: Record<string, Verdict> = {};
  let spent = 0;
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const info = queue[next++];
      if (spent + worst(info) > budget) { results[info.id] = { streams: "unknown", deltas: 0, spreadMs: 0, argChars: 0, cost: 0, note: "budget" }; continue; }
      const apiKey = keys[info.provider];
      if (!apiKey) { results[info.id] = { streams: "unknown", deltas: 0, spreadMs: 0, argChars: 0, cost: 0, note: "no platform key" }; continue; }
      const taken: Verdict[] = [];
      for (let sample = 0; sample < samples && !taken.some(verdict => verdict.streams === false); sample++) {
        if (sample && spent + worst(info) > budget) break;
        let verdict: Verdict;
        try { verdict = await probe(resolveModel(info.id) as Model<Api>, apiKey); }
        catch (caught) { verdict = { streams: "unknown", deltas: 0, spreadMs: 0, argChars: 0, cost: 0, note: String((caught as Error).message).slice(0, 160) }; }
        spent += verdict.cost;
        taken.push(verdict);
        console.log(`${String(verdict.streams).padEnd(7)} ${info.id} #${sample + 1}  deltas=${verdict.deltas} spread=${verdict.spreadMs}ms chars=${verdict.argChars} $${verdict.cost.toFixed(4)}${verdict.note ? `  (${verdict.note})` : ""}`);
      }
      results[info.id] = { ...taken[taken.length - 1], streams: combine(taken.map(verdict => verdict.streams)), cost: taken.reduce((sum, verdict) => sum + verdict.cost, 0) };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Only definite verdicts are recorded; a probe that could not tell leaves an earlier measurement in place. A model
  // measured true before that came in one piece now is false from now on.
  const models: Record<string, boolean> = { ...existing.models };
  for (const [id, verdict] of Object.entries(results)) if (verdict.streams !== "unknown") models[id] = verdict.streams;
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(OUT, `${JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), method: "scripts/probe-tool-streaming.ts", models: sorted }, null, 2)}\n`);
  const tally = (value: boolean | "unknown") => Object.values(results).filter(verdict => verdict.streams === value).length;
  console.log(`\nstreams ${tally(true)}, one piece ${tally(false)}, unknown ${tally("unknown")}; spent $${spent.toFixed(3)}; wrote ${OUT}`);
}
