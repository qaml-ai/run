/** Read a Secrets Manager secret's string on each call; the SDK loads only when a secret is configured. */
export async function secretReader(secretId: string, env = process.env): Promise<() => Promise<string>> {
  const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
  return async () => (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString ?? "";
}
