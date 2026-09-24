import { createExecutorServer } from "./executor.ts";
import { sandboxLauncher } from "./sandbox.ts";
import { rotatingToken, staticToken } from "./token.ts";

// Executor host entry point. On executor hosts its environment holds no secret:
// the token is read from Secrets Manager (AGENT_EXECUTOR_TOKEN_SECRET_ARN, with the
// instance role) and re-read, so rotation needs no restart. AGENT_EXECUTOR_TOKEN
// serves development and tests. Everything is read once and then the whole
// environment is dropped; sandboxes never inherit it either.
const env = process.env;
const port = Number(env.PORT ?? 8790);
const host = env.HOST ?? "127.0.0.1";
const maxConcurrent = Number(env.AGENT_EXECUTOR_MAX_CONCURRENCY ?? 8);
if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("AGENT_EXECUTOR_MAX_CONCURRENCY must be a positive integer");
const launcher = sandboxLauncher(env.AGENT_EXECUTOR_SANDBOX, { runtime: env.AGENT_RUNTIME, helper: env.AGENT_EXECUTOR_SANDBOX_HELPER });
const secretId = env.AGENT_EXECUTOR_TOKEN_SECRET_ARN;
const token = secretId ? await secretToken(secretId, env.AWS_REGION) : staticToken(env.AGENT_EXECUTOR_TOKEN ?? "");
for (const key of Object.keys(env)) if (key !== "PATH") delete env[key];

async function secretToken(secretId: string, region?: string) {
  const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({ region });
  return rotatingToken(async () => (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString ?? "");
}

const server = createExecutorServer({ token, maxConcurrent, launcher });
server.listen(port, host, () => {
  console.log(JSON.stringify({ type: "listening", address: server.address(), maxConcurrent, sandbox: launcher.kind }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  // Running executions end with their runtime's deadline; stop taking new ones.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 125_000).unref();
});
