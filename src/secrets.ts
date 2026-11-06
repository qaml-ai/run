import { azureOpenAIConfig, type AzureOpenAI } from "./azure-openai.ts";

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
  const journeyArn = exclusive(["AGENT_JOURNEY_SECRET"], "AGENT_JOURNEY_SECRET_ARN");
  // Journey events' signing secret (src/journey.ts): named only where the operator set one. Like Stripe's, the
  // secret may exist before anyone stores its value: null, and until then journey events are off.
  let journeySecret: string | null | undefined = env.AGENT_JOURNEY_SECRET;
  if (journeyArn) {
    try { journeySecret = (await read(journeyArn)).trim() || null; }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; journeySecret = null; }
    if (journeySecret === null) console.error(JSON.stringify({ type: "journey_not_configured", reason: "AGENT_JOURNEY_SECRET_ARN has no value yet" }));
  }
  // The secret the admin site asks the journey store's reports with (src/admin-report.ts). Like Stripe's, the secret
  // may exist before anyone stores its value: until then the site says reports are not configured.
  const reportArn = exclusive(["AGENT_JOURNEY_REPORT_SECRET"], "AGENT_JOURNEY_REPORT_SECRET_ARN");
  let journeyReportSecret = env.AGENT_JOURNEY_REPORT_SECRET;
  if (reportArn) {
    try { journeyReportSecret = (await read(reportArn)).trim() || undefined; }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; journeyReportSecret = undefined; }
  }
  // The platform's Azure OpenAI resource, for images, transcription and realtime voice on the platform's key (azure-openai.ts). Like
  // Stripe's, the secret may exist before anyone stores its value: until then they stay on OpenAI.
  const azureArn = exclusive(["AGENT_AZURE_OPENAI_ENDPOINT", "AGENT_AZURE_OPENAI_API_KEY"], "AGENT_AZURE_OPENAI_SECRET_ARN");
  let azureOpenAI: AzureOpenAI | undefined;
  if (azureArn) {
    let text = "";
    try { text = await read(azureArn); }
    catch (error) { if ((error as Error).name !== "ResourceNotFoundException") throw error; }
    if (text.trim()) azureOpenAI = azureOpenAIConfig(JSON.parse(text), "AGENT_AZURE_OPENAI_SECRET_ARN");
  } else {
    azureOpenAI = azureOpenAIConfig({
      endpoint: env.AGENT_AZURE_OPENAI_ENDPOINT, apiKey: env.AGENT_AZURE_OPENAI_API_KEY,
      imageDeployment: env.AGENT_AZURE_IMAGE_DEPLOYMENT, transcriptionDeployment: env.AGENT_AZURE_TRANSCRIPTION_DEPLOYMENT,
      realtimeDeployment: env.AGENT_AZURE_REALTIME_DEPLOYMENT, realtimeModels: env.AGENT_AZURE_REALTIME_MODELS, apiVersion: env.AGENT_AZURE_OPENAI_API_VERSION, models: env.AGENT_AZURE_OPENAI_MODELS,
    }, "AGENT_AZURE_OPENAI_ENDPOINT and AGENT_AZURE_OPENAI_API_KEY");
  }
  return {
    ...(journeySecret === undefined ? {} : { journeySecret }),
    ...(azureOpenAI ? { azureOpenAI } : {}),
    // Reports are the journey store's: with journey events waiting for their secret, they wait too.
    ...(journeyReportSecret && journeySecret !== null ? { journeyReportSecret } : {}),
    sessionSecret: sessionArn ? await read(sessionArn) : env.AGENT_SESSION_SECRET,
    secretsKey: keyArn ? await read(keyArn) : env.AGENT_SECRETS_KEY,
    github,
    google,
    stripe,
  };
}
