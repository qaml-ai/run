// The synthetic check (infra/terraform/synthetic.tf): a scheduled Lambda that uses the public API as a customer does,
// from outside (through Cloudflare and the load balancer): GET /healthz, then one stateless run of a real model turn
// (POST /v1/runs?wait=60), answered "OK". Each check writes one `synthetic_check` line in CloudWatch Embedded Metric
// Format (namespace AgentRuntime, as the runtime's own: SyntheticChecks, SyntheticFailures, SyntheticRunMs), which the
// -synthetic alarm reads. Its operator token is read from Secrets Manager (SYNTHETIC_SECRET_ID) on each cold start.
// The Lambda runtime's own AWS SDK; nothing else is imported.
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const url = (process.env.SYNTHETIC_URL ?? "https://run.camelai.com").replace(/\/$/, "");
const service = process.env.SYNTHETIC_SERVICE_NAME;
let token;

/** SYNTHETIC_TOKEN when given (a run by hand, the tests), else the secret's value. */
async function operatorToken() {
  token ??= process.env.SYNTHETIC_TOKEN
    ?? (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.SYNTHETIC_SECRET_ID }))).SecretString?.trim();
  if (!token) throw new Error("The synthetic secret has no value");
  return token;
}

async function call(path, init = {}, timeoutMs = 15_000) {
  const response = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: response.status, body };
}

/** One check: the step that failed and why (the API's code and status, never a model's words), or none. */
export async function check() {
  const health = await call("/healthz");
  if (health.status !== 200) return { step: "healthz", error: `HTTP ${health.status}` };
  const auth = { authorization: `Bearer ${await operatorToken()}`, "content-type": "application/json" };
  const started = Date.now();
  const run = {
    input: "This is an automated health check. Reply with the single word OK.",
    spendLimit: { usd: 0.05 }, retentionSeconds: 3600, metadata: { synthetic: "1" },
    ...(process.env.SYNTHETIC_MODEL ? { model: process.env.SYNTHETIC_MODEL } : {}),
  };
  let answer = await call("/v1/runs?wait=60", { method: "POST", headers: { ...auth, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(run) }, 75_000);
  for (let polls = 0; answer.status < 300 && answer.body.status === "running" && polls < 2; polls++) {
    answer = await call(`/v1/runs/${encodeURIComponent(answer.body.id)}?wait=25`, { headers: auth }, 40_000);
  }
  const runMs = Date.now() - started;
  if (answer.status >= 300) return { step: "run", error: `HTTP ${answer.status} ${answer.body.code ?? ""}`.trim(), runMs };
  if (answer.body.status !== "completed") return { step: "run", error: `run ${answer.body.status} ${answer.body.error?.code ?? ""}`.trim(), runMs };
  if (!/\bok\b/i.test(answer.body.text ?? "")) return { step: "run", error: "the reply was not OK", runMs };
  return { runMs };
}

export function line(result, now = Date.now()) {
  const failed = result.error !== undefined;
  const metrics = [{ Name: "SyntheticChecks", Unit: "Count" }, { Name: "SyntheticFailures", Unit: "Count" }, ...(result.runMs !== undefined ? [{ Name: "SyntheticRunMs", Unit: "Milliseconds" }] : [])];
  return JSON.stringify({
    _aws: { Timestamp: now, CloudWatchMetrics: [{ Namespace: "AgentRuntime", Dimensions: [service ? ["ServiceName"] : []], Metrics: metrics }] },
    type: "synthetic_check", ...(service ? { ServiceName: service } : {}), url, ok: !failed, ...(failed ? { step: result.step, error: result.error } : {}),
    SyntheticChecks: 1, SyntheticFailures: failed ? 1 : 0, ...(result.runMs !== undefined ? { SyntheticRunMs: result.runMs } : {}),
  });
}

export async function handler() {
  let result;
  try { result = await check(); }
  catch (error) { result = { step: "check", error: String(error?.name === "TimeoutError" ? "timed out" : error?.message ?? error).slice(0, 200) }; }
  console.log(line(result));
  return { ok: result.error === undefined };
}
