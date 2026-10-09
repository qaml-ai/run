/**
 * The platform's Azure OpenAI resource, for images and transcription made on the platform's key (images.ts,
 * transcription.ts): where a prepaid tenant's request would use the platform's OpenAI key, it goes to the Azure deployment
 * instead, with that key as the fallback when Azure fails for now (rate limited, down, the deployment missing). A tenant's
 * own key, an operator-set key and a key scope's stay on OpenAI. Billing is unchanged: Azure's global prices for these
 * models are OpenAI's, and usage is priced from the tokens or seconds the answer reports.
 *
 * Configured with AGENT_AZURE_OPENAI_SECRET_ARN (JSON {endpoint, apiKey, imageDeployment?, transcriptionDeployment?,
 * apiVersion?}), or AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY (with AGENT_AZURE_IMAGE_DEPLOYMENT,
 * AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT and AGENT_AZURE_OPENAI_API_VERSION). A deployment defaults to its model's name;
 * "" leaves that kind on OpenAI.
 */
export type AzureOpenAI = { endpoint: string; apiKey: string; apiVersion: string; imageDeployment?: string; transcriptionDeployment?: string };

const DEFAULT_DEPLOYMENTS = { imageDeployment: "gpt-image-2.5-flare", transcriptionDeployment: "gpt-transcribe" };
/** The data-plane API version both kinds answer on (Azure's v1 API does not route audio to a gpt-transcribe deployment). */
export const AZURE_API_VERSION = "2025-04-01-preview";

/** Settings as given (the secret's JSON, or the environment's), checked; undefined when there are none. */
export function azureOpenAIConfig(value: { endpoint?: unknown; apiKey?: unknown; imageDeployment?: unknown; transcriptionDeployment?: unknown; apiVersion?: unknown } | undefined, source: string): AzureOpenAI | undefined {
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
    if (typeof given !== "string" || !/^[A-Za-z0-9._-]{0,64}$/.test(given)) throw new Error(`${source}: ${name} must be a deployment name`);
    return given || undefined;
  };
  const imageDeployment = deployment("imageDeployment"), transcriptionDeployment = deployment("transcriptionDeployment");
  return { endpoint: url.origin, apiKey, apiVersion, ...(imageDeployment ? { imageDeployment } : {}), ...(transcriptionDeployment ? { transcriptionDeployment } : {}) };
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
