import { azureOpenAIConfig, azureCredentials } from "./azure-policy.ts";

export type MediaAzureEnv = {
  AGENT_AZURE_OPENAI_ENDPOINT?: string;
  AGENT_AZURE_OPENAI_API_KEY?: string;
  AGENT_AZURE_OPENAI_API_VERSION?: string;
  AGENT_AZURE_IMAGE_DEPLOYMENT?: string;
  AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT?: string;
  TEST_MODE?: string;
};

/** Workers bind secrets directly. Media settings use the source validator and
 * defaults; realtime and chat deployments remain outside this media adapter. */
export function mediaAzure(env: MediaAzureEnv) {
  const azure = azureOpenAIConfig({
    endpoint: env.AGENT_AZURE_OPENAI_ENDPOINT,
    apiKey: env.AGENT_AZURE_OPENAI_API_KEY,
    apiVersion: env.AGENT_AZURE_OPENAI_API_VERSION,
    imageDeployment: env.AGENT_AZURE_IMAGE_DEPLOYMENT,
    transcriptionDeployment: env.AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT,
    realtimeDeployment: "",
  }, "AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY");
  if (azure && env.TEST_MODE !== "1") {
    const url = new URL(azure.endpoint);
    if (url.protocol !== "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Azure media endpoint must use non-loopback HTTPS outside TEST_MODE");
  }
  return azure;
}

export { azureCredentials };
