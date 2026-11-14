import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { fileURLToPath } from "node:url";
/** Swap only the server fixture. All assertions and fake-provider responses stay upstream. */
import {
  fakeModel,
  OPERATOR,
  OTHER_OPERATOR,
} from "../../../tests/runtime-server.ts";
import { startFixture } from "./fixture.ts";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export async function compatibilityRuntime(
  t: any,
  respond: any,
  env: Record<string, string> = {},
  tenantsFile?: any,
  options?: { camelfsTier?: boolean },
) {
  const root = await mkdtemp(join(tmpdir(), 'camelrun-proto-sdk-files-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const model = await fakeModel(t, respond);
  // Match tests/runtime-server.ts: a default fixture can use its fake model.
  // Explicit configurations retain missing-key and provider-policy coverage.
  const defaultTenants = { tenants: Object.fromEntries([["alice", OPERATOR], ["bob", OTHER_OPERATOR]].map(([id, token]) =>
    [id, { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: { openrouter: "fixture-model-key" } }])) };
  const tenants = [
    { id: "alice", token: OPERATOR },
    { id: "bob", token: OTHER_OPERATOR },
    ...Object.entries(tenantsFile?.tenants ?? {}).map(
      ([id, value]: [string, any]) => ({
        id,
        tokenSha256: value.tokenSha256,
        billing: value.billing ?? 'none',
        seedCredit: false,
      }),
    ),
  ];
  const camelfs = options?.camelfsTier ? undefined : await serveFakeCamelfsd("compat-repo-token");
  if (camelfs) t.after(() => camelfs.close());
  const server = await startFixture({
    camelfsTier: options?.camelfsTier, camelfsStub:true,entrypoint:fileURLToPath(new URL("./camelfs-worker.ts",import.meta.url)),
    token: OPERATOR,
    tenant: "alice",
    modelURL: env.AGENT_BASE_URL ?? model.url,
    tenants,
    vars: {
      ...(camelfs ? { TEST_CAMELFS_URL: camelfs.url, CAMELFS_API_TOKEN: "compat-repo-token" } : {}),
      ...env,
      ...(tenantsFile ? { AGENT_TENANTS_JSON: JSON.stringify(tenantsFile) } : env.AGENT_TENANTS_JSON ? {} : { AGENT_TENANTS_JSON: JSON.stringify(defaultTenants) }),
      ...(tenantsFile ? { TEST_DECISION_KEYS: JSON.stringify({ tenants: Object.fromEntries(Object.entries(tenantsFile.tenants ?? {}).map(([id, value]: [string, any]) => [id, { apiKeys: value.apiKeys, platformKeys: value.platformKeys }])), platformKeys: tenantsFile.platformKeys }) } : {}),
      MODEL: `${env.AGENT_PROVIDER ?? "openrouter"}/${env.AGENT_MODEL ?? "openai/gpt-4o-mini"}`,
      PUBLIC_BASE_URL: env.AGENT_PUBLIC_URL ?? 'https://agents.example.test',
      ...(env.AGENT_IMAGES_URL || env.AGENT_TRANSCRIPTION_URL || env.AGENT_SPEECH_URL ? { MEDIA_BASE_URL: env.AGENT_IMAGES_URL ?? env.AGENT_TRANSCRIPTION_URL ?? env.AGENT_SPEECH_URL } : {}),
      ...(tenantsFile?.platformKeys?.openai ? {PLATFORM_OPENAI_KEY:tenantsFile.platformKeys.openai} : {}),
      TEST_MEDIA_TENANTS: JSON.stringify(tenantsFile ?? {}),
      ...(env.AGENT_ACCOUNT_EMAIL_FROM ? {SCHEDULE_EMAIL_FROM:env.AGENT_ACCOUNT_EMAIL_FROM} : {}),
      SCHEDULE_OPERATOR_TENANTS: tenants.map(t=>t.id).join(','),
      MEDIA_PRICING: JSON.stringify({
        ...(env.AGENT_PRICE_IMAGE_OUTPUT_USD ? {image: { textInput:Number(env.AGENT_PRICE_IMAGE_TEXT_INPUT_USD ?? 5)*1e6,imageInput:Number(env.AGENT_PRICE_IMAGE_INPUT_USD ?? 8)*1e6,output:Number(env.AGENT_PRICE_IMAGE_OUTPUT_USD)*1e6 }} : {}),
        ...(env.AGENT_PRICE_TRANSCRIPTION_USD ? {transcription:Number(env.AGENT_PRICE_TRANSCRIPTION_USD)*1e6} : {}),
      }),
    },
  });
  t.after(() => server.stop());
  const call = async (path: string, init: any = {}) => {
    const token = init.token === undefined ? OPERATOR : init.token;
    const response = await fetch(server.url + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, text, headers: response.headers };
  };
  const prompt = async (
    agent: string,
    text: string,
    token?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const sent = await call(`/v1/agents/${agent}/prompt`, {
      body: { text, ...extra },
      token,
    });
    if (sent.status !== 202)
      throw new Error(`prompt: ${sent.status} ${sent.text}`);
    const id = sent.json.id;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const r = await call(`/v1/agents/${agent}/requests/${id}`, { token });
      if (r.json.state === "completed") return r.json;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("Fixture turn timed out");
  };
  return {
    root,
    base: server.url,
    baseUrl: server.url,
    databaseUrl: server.databaseUrl,
    db: server.db,
    call,
    prompt,
    model,
    get logs() { return server.worker.logs().split("\n"); },
    child: {
      kill: () => {
        void server.stop();
      },
      exitCode: null,
    },
  };
}
