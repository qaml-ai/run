/** The platform may inject federation credentials without importing AWS host clients. */
export interface AnthropicFederation {
  credentials(fallback?: string): Promise<{ apiKey: string; bearer?: true }>;
}
export type AzureOpenAI = {
  endpoint: string; apiKey: string; apiVersion: string; imageDeployment?: string; transcriptionDeployment?: string;
  realtimeDeployment?: string; realtimeModels?: Record<string, string>; models?: Record<string, string>;
};
/** Workers bind their tenant JSON and credentials directly. No host files or AWS discovery. */
export function readFileSync(..._args: unknown[]): string {
  throw new Error("Workers tenant configuration must use AGENT_TENANTS_JSON");
}
export async function secretReader(..._args: unknown[]): Promise<() => Promise<string>> {
  throw new Error("Workers tenant configuration must use AGENT_TENANTS_JSON");
}
