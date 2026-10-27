// Checks the platform's Azure OpenAI chat deployments (src/azure-openai.ts) after their settings are stored: for each
// azure model configured (or those given with --only), one minimal call through the path the runtime uses
// (explicitKeyStream with the credentials the runtime passes), asking for a one-word answer with the least output the
// Responses API takes (16 tokens, also used for Chat Completions) and the least reasoning the model allows.
// Prints one JSON line per model: its API, ok or the error as Azure gave it (401 key refused, 404 deployment missing, 429 rate limited, a content filter), and its tokens
// and cost at the catalog's prices. A run costs well under a cent per model.
//
//   node --experimental-strip-types scripts/azure-models-check.ts [--only gpt-6-sol,gpt-6-luna] [--dry-run]
//
// Settings: AGENT_AZURE_OPENAI_ENDPOINT, AGENT_AZURE_OPENAI_API_KEY and AGENT_AZURE_OPENAI_MODELS from the environment,
// or else the Secrets Manager secret named by AGENT_AZURE_OPENAI_SECRET_ARN (or --secret), as the runtime reads them.
// The key is held in memory only and never printed. --dry-run checks the settings and lists the calls without making them.
// Exits 1 when any call failed.
import type { Context } from "@earendil-works/pi-ai";
import { azureChatCredentials, azureOpenAIConfig } from "../src/azure-openai.ts";
import { explicitKeyStream } from "../src/compaction.ts";
import { reasoningFloor } from "../src/pi-catalog.ts";
import { secretReader } from "../src/secrets.ts";
import { resolveModel } from "../src/session-config.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const dryRun = args.includes("--dry-run");

const env = process.env;
const arn = flag("secret") ?? env.AGENT_AZURE_OPENAI_SECRET_ARN;
const azure = env.AGENT_AZURE_OPENAI_ENDPOINT || !arn
  ? azureOpenAIConfig({ endpoint: env.AGENT_AZURE_OPENAI_ENDPOINT, apiKey: env.AGENT_AZURE_OPENAI_API_KEY, models: env.AGENT_AZURE_OPENAI_MODELS }, "AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY")
  : azureOpenAIConfig(JSON.parse(await (await secretReader(arn))() || "{}"), arn);
if (!azure) throw new Error("No Azure OpenAI settings: set AGENT_AZURE_OPENAI_ENDPOINT, AGENT_AZURE_OPENAI_API_KEY and AGENT_AZURE_OPENAI_MODELS, or AGENT_AZURE_OPENAI_SECRET_ARN");
const credentials = azureChatCredentials(azure);
const only = flag("only")?.split(",").map(id => id.trim()).filter(Boolean);
const ids = only ?? Object.keys(credentials.deployments);
if (!ids.length) throw new Error("No azure chat models configured (models in the secret, or AGENT_AZURE_OPENAI_MODELS)");

const context: Context = { systemPrompt: "Answer with one word.", messages: [{ role: "user", content: "Say ok.", timestamp: Date.now() }] };
let failed = false;
for (const id of ids) {
  const deployment = credentials.deployments[id];
  const model = deployment ? resolveModel(`azure/${id}`) : undefined;
  const line: Record<string, unknown> = { model: `azure/${id}`, deployment: deployment ?? null, endpoint: azure.endpoint, ...(model ? { api: model.api } : {}) };
  if (dryRun || !deployment) {
    if (!deployment) { failed = true; line.error = "not configured: no deployment for this model, or not an azure model in the catalog"; }
    console.log(JSON.stringify(line));
    continue;
  }
  if (!model) continue;
  const started = performance.now();
  // Each call takes its credentials as the runtime's agents do (`perCall`), so the key never reaches the options logged.
  const stream = explicitKeyStream(() => Promise.resolve(credentials))(model, context as never, { apiKey: "per-call", maxTokens: 16, reasoning: reasoningFloor(model), signal: AbortSignal.timeout(60_000) } as never);
  const message = await (await stream).result();
  line.ms = Math.round(performance.now() - started);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    failed = true;
    line.error = message.errorMessage;
  } else {
    line.ok = true;
    line.stopReason = message.stopReason;
    line.text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").slice(0, 80);
    line.usage = { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, usd: Number(message.usage.cost.total.toFixed(6)) };
  }
  console.log(JSON.stringify(line));
}
process.exitCode = failed ? 1 : 0;
