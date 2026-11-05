import { azureOpenAIConfig } from "./azure-policy.ts";

export type ModelAzureEnv = {
  AGENT_AZURE_OPENAI_ENDPOINT?: string;
  AGENT_AZURE_OPENAI_API_KEY?: string;
  AGENT_AZURE_OPENAI_MODELS?: string;
  TEST_MODE?: string;
};

/** Chat uses the same source deployment policy as media, with explicit model mappings. */
export function modelAzure(env: ModelAzureEnv) {
  const azure = azureOpenAIConfig({
    endpoint: env.AGENT_AZURE_OPENAI_ENDPOINT,
    apiKey: env.AGENT_AZURE_OPENAI_API_KEY,
    models: env.AGENT_AZURE_OPENAI_MODELS,
    imageDeployment: "", transcriptionDeployment: "", realtimeDeployment: "",
  }, "AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY");
  if (azure && env.TEST_MODE !== "1" && new URL(azure.endpoint).protocol !== "https:")
    throw new Error("Azure model endpoint must use HTTPS outside TEST_MODE");
  return azure;
}
