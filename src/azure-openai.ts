import { getModels } from "./pi-catalog.ts";

/**
 * The platform's Azure OpenAI resource, for images and transcription made on the platform's key (images.ts,
 * transcription.ts): where a prepaid tenant's request would use the platform's OpenAI key, it goes to the Azure deployment
 * instead, with that key as the fallback when Azure fails for now (rate limited, down, the deployment missing). A tenant's
 * own key, an operator-set key and a key scope's stay on OpenAI. Billing is unchanged: Azure's global prices for these
 * models are OpenAI's, and usage is priced from the tokens or seconds the answer reports.
 *
 * The same resource serves the catalog's `azure/<model>` chat models, on the platform's account only (`models`: each
 * model's deployment; a model without one is not offered). See azureChatCredentials.
 *
 * Configured with AGENT_AZURE_OPENAI_SECRET_ARN (JSON {endpoint, apiKey, imageDeployment?, transcriptionDeployment?,
 * apiVersion?, models?}), or AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY (with AGENT_AZURE_IMAGE_DEPLOYMENT,
 * AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT, AGENT_AZURE_OPENAI_API_VERSION and AGENT_AZURE_OPENAI_MODELS). A media deployment
 * defaults to its model's name; "" leaves that kind on OpenAI. Chat models have none by default.
 */
export type AzureOpenAI = { endpoint: string; apiKey: string; apiVersion: string; imageDeployment?: string; transcriptionDeployment?: string; models?: Record<string, string> };

const DEFAULT_DEPLOYMENTS = { imageDeployment: "gpt-image-2.5-flare", transcriptionDeployment: "gpt-transcribe" };
/** The data-plane API version both kinds answer on (Azure's v1 API does not route audio to a gpt-transcribe deployment). */
export const AZURE_API_VERSION = "2025-04-01-preview";

/** Settings as given (the secret's JSON, or the environment's), checked; undefined when there are none. */
export function azureOpenAIConfig(value: { endpoint?: unknown; apiKey?: unknown; imageDeployment?: unknown; transcriptionDeployment?: unknown; apiVersion?: unknown; models?: unknown } | undefined, source: string): AzureOpenAI | undefined {
  if (!value || (value.endpoint === undefined && value.apiKey === undefined)) return undefined;
  const { endpoint, apiKey } = value;
  if (typeof endpoint !== "string" || typeof apiKey !== "string" || !apiKey) throw new Error(`${source} must give endpoint (https://<resource>.openai.azure.com) and apiKey`);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error(`${source}: endpoint is not a URL`); }
  // Plain http only on loopback, for a local stand-in.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error(`${source}: endpoint must be https`);
  const apiVersion = value.apiVersion === undefined || value.apiVersion === "" ? AZURE_API_VERSION : value.apiVersion;
  if (typeof apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(apiVersion)) throw new Error(`${source}: apiVersion must be like ${AZURE_API_VERSION}`);
  const deployment = (name: "imageDeployment" | "transcriptionDeployment") => {
    const given = value[name];
    if (given === undefined) return DEFAULT_DEPLOYMENTS[name];
    if (typeof given !== "string" || !DEPLOYMENT.test(given)) throw new Error(`${source}: ${name} must be a deployment name`);
    return given || undefined;
  };
  const imageDeployment = deployment("imageDeployment"), transcriptionDeployment = deployment("transcriptionDeployment");
  const models = chatDeployments(value.models, source);
  return { endpoint: url.origin, apiKey, apiVersion, ...(imageDeployment ? { imageDeployment } : {}), ...(transcriptionDeployment ? { transcriptionDeployment } : {}), ...(models ? { models } : {}) };
}

const DEPLOYMENT = /^[A-Za-z0-9._-]{0,64}$/;

/**
 * The chat models' deployments: an object of catalog model id to deployment name, or (as an environment variable) the
 * text `gpt-6-sol=sol-eastus2,gpt-6-luna`, where a model alone is deployed under its own name. Each must be one of
 * the catalog's `azure` models on the Responses API (scripts/azure-models-check.ts checks them). Undefined when there are none.
 */
function chatDeployments(given: unknown, source: string): Record<string, string> | undefined {
  if (given === undefined || given === "") return undefined;
  const entries = typeof given === "string"
    ? given.split(",").map(entry => entry.trim()).filter(Boolean).map(entry => { const [id, name = id] = entry.split("=").map(part => part.trim()); return [id, name] as [string, unknown]; })
    : given && typeof given === "object" && !Array.isArray(given) ? Object.entries(given) : undefined;
  if (!entries) throw new Error(`${source}: models must map catalog model ids to deployment names`);
  for (const [id, name] of entries) if (typeof name !== "string" || !name || !DEPLOYMENT.test(name)) throw new Error(`${source}: the deployment of ${id} must be a deployment name`);
  // A model the catalog lacks (a typo, or one a Pi upgrade dropped) is left out and logged, rather than stop the runtime starting.
  const offered = new Set(getModels("azure").filter(model => model.api === "azure-openai-responses").map(model => model.id));
  const unknown = entries.filter(([id]) => !offered.has(id)).map(([id]) => id);
  if (unknown.length) console.error(JSON.stringify({ type: "azure_models_unknown", source, models: unknown }));
  const known = entries.filter(([id]) => offered.has(id));
  return known.length ? Object.fromEntries(known) as Record<string, string> : undefined;
}

/** Azure's v1 data-plane API, which serves the Responses API by deployment name in the body's `model`. */
export const AZURE_CHAT_API_VERSION = "v1";

/**
 * Credentials for the platform's calls to a chat model on Azure (compaction.ts `authorize`): the key, sent by Pi's
 * Azure client as the `api-key` header, the resource's v1 API root, and the deployments by model id. Separate from the
 * media's `apiVersion`, which names a dated version for the deployment paths those use.
 */
export function azureChatCredentials(azure: AzureOpenAI) {
  return { apiKey: azure.apiKey, baseUrl: `${azure.endpoint}/openai/v1`, deployments: azure.models ?? {} };
}

/**
 * Credentials for an Azure deployment: its data-plane address (`/openai/deployments/<deployment>`, which takes OpenAI's
 * paths and bodies with `?api-version=`), the key as the `api-key` header, falling back on `fallback`: the platform's
 * OpenAI key.
 */
export function azureCredentials<T extends { apiKey: string }>(azure: AzureOpenAI, deployment: string, fallback: T) {
  return {
    apiKey: "", baseUrl: `${azure.endpoint}/openai/deployments/${encodeURIComponent(deployment)}`, query: `api-version=${azure.apiVersion}`,
    model: deployment, secrets: { "api-key": azure.apiKey }, via: "azure" as const, fallback,
  };
}
