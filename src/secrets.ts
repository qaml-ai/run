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
  // Google sign-in. Like Stripe's, the secret may exist before anyone stores its value: until then Google sign-in is off.
  const googleArn = exclusive(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "AGENT_GOOGLE_OAUTH_SECRET_ARN");
  let google: { clientId: string; clientSecret: string } | undefined;
  if (googleArn) {
    let text = "";
    try { text = await read(googleArn); }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; }
    if (text) {
      const { clientId, clientSecret } = JSON.parse(text);
      if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) throw new Error("AGENT_GOOGLE_OAUTH_SECRET_ARN must hold {clientId, clientSecret}");
      google = { clientId, clientSecret };
    }
  } else if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
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
  // A dedicated key for tool search's ranking by meaning (AGENT_TOOL_SEARCH). Null: the secret has no
  // value, and search uses the platform's OpenRouter key from the tenants file.
  const toolSearchArn = exclusive(["AGENT_TOOL_SEARCH_API_KEY"], "AGENT_TOOL_SEARCH_SECRET_ARN");
  const billingEmailArn = exclusive(["AGENT_BILLING_EMAIL_SECRET"], "AGENT_BILLING_EMAIL_SECRET_ARN");
  let toolSearchKey: string | null | undefined = env.AGENT_TOOL_SEARCH_API_KEY;
  if (toolSearchArn) {
    try { toolSearchKey = (await read(toolSearchArn)).trim() || null; }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; toolSearchKey = null; }
  }
  return {
    billingEmailSecret: billingEmailArn ? (await read(billingEmailArn)).trim() : env.AGENT_BILLING_EMAIL_SECRET,
    toolSearchKey,
    sessionSecret: sessionArn ? await read(sessionArn) : env.AGENT_SESSION_SECRET,
    secretsKey: keyArn ? await read(keyArn) : env.AGENT_SECRETS_KEY,
    github,
    google,
    stripe,
  };
}

/** Managed Discord is opt-in. In hosted deployments load platform credentials from Secrets Manager. */
export async function managedDiscordSecrets(env = process.env) {
  if (env.AGENT_DISCORD_MANAGED_ENABLED !== "true") return undefined;
  const names = ["BOT_TOKEN", "APPLICATION_ID", "CLIENT_SECRET"];
  let values: Record<string, unknown>;
  if (env.AGENT_DISCORD_MANAGED_SECRET_ARN) {
    if (names.some(name => env[`AGENT_DISCORD_MANAGED_${name}`])) throw new Error("Set AGENT_DISCORD_MANAGED_SECRET_ARN or managed Discord values, not both");
    // Like Stripe and Google: a secret Terraform made but nothing has filled yet leaves the integration off.
    let text = "";
    try { text = await (await secretReader(env.AGENT_DISCORD_MANAGED_SECRET_ARN, env))(); }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; }
    try { values = JSON.parse(text || "{}"); } catch { values = {}; }
  } else {
    values = { botToken: env.AGENT_DISCORD_MANAGED_BOT_TOKEN, applicationId: env.AGENT_DISCORD_MANAGED_APPLICATION_ID,
      clientSecret: env.AGENT_DISCORD_MANAGED_CLIENT_SECRET };
  }
  // Any other field (an older secret's publicKey) is ignored.
  if (!values.botToken || !values.applicationId || !values.clientSecret) {
    console.error(JSON.stringify({ type: "discord_managed_not_configured" }));
    return undefined;
  }
  if (typeof values.botToken !== "string" || !/^[A-Za-z0-9_.-]{50,100}$/.test(values.botToken)
      || typeof values.applicationId !== "string" || !/^\d{1,20}$/.test(values.applicationId)
      || typeof values.clientSecret !== "string") {
    // A malformed optional integration must not stop every node from starting: it stays off, and says so.
    console.error(JSON.stringify({ type: "discord_managed_not_configured", reason: "Managed Discord credentials must hold valid {botToken, applicationId, clientSecret}" }));
    return undefined;
  }
  return { botToken: values.botToken, applicationId: values.applicationId, clientSecret: values.clientSecret };
}
