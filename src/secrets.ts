/** Read a Secrets Manager secret's string on each call; the SDK loads only when a secret is configured. */
export async function secretReader(secretId: string, env = process.env): Promise<() => Promise<string>> {
  const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
  return async () => (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString ?? "";
}

/**
 * The runtime's own secrets, as plain values (development, the EC2 host) or as
 * Secrets Manager ARNs read once at startup. On ECS only the ARNs are set: sandbox
 * children run as the runtime's uid and could read its /proc/<pid>/environ.
 */
export async function runtimeSecrets(env = process.env) {
  const exclusive = (plain: string[], arn: string) => {
    if (env[arn] && plain.some(name => env[name])) throw new Error(`Set ${plain.join("/")} or ${arn}, not both`);
    return env[arn];
  };
  const read = async (arn: string) => (await secretReader(arn, env))();
  const sessionArn = exclusive(["AGENT_SESSION_SECRET"], "AGENT_SESSION_SECRET_ARN");
  const keyArn = exclusive(["AGENT_SECRETS_KEY"], "AGENT_SECRETS_KEY_ARN");
  const githubArn = exclusive(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"], "AGENT_GITHUB_OAUTH_SECRET_ARN");
  let github: { clientId: string; clientSecret: string } | undefined;
  if (githubArn) {
    const { clientId, clientSecret } = JSON.parse(await read(githubArn) || "{}");
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) throw new Error("AGENT_GITHUB_OAUTH_SECRET_ARN must hold {clientId, clientSecret}");
    github = { clientId, clientSecret };
  } else if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  // Stripe, for credit purchases. The secret may exist before anyone stores its value: until then purchases are off.
  const stripeArn = exclusive(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], "AGENT_STRIPE_SECRET_ARN");
  let stripe: { secretKey: string; webhookSecret: string } | undefined;
  if (stripeArn) {
    let text = "";
    try { text = await read(stripeArn); }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; }
    if (text) {
      const { secretKey, webhookSecret } = JSON.parse(text);
      if (typeof secretKey !== "string" || !secretKey || typeof webhookSecret !== "string" || !webhookSecret) throw new Error("AGENT_STRIPE_SECRET_ARN must hold {secretKey, webhookSecret}");
      stripe = { secretKey, webhookSecret };
    } else console.error(JSON.stringify({ type: "stripe_not_configured", reason: "AGENT_STRIPE_SECRET_ARN has no value yet" }));
  } else if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) stripe = { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
  return {
    sessionSecret: sessionArn ? await read(sessionArn) : env.AGENT_SESSION_SECRET,
    secretsKey: keyArn ? await read(keyArn) : env.AGENT_SECRETS_KEY,
    github,
    stripe,
  };
}
