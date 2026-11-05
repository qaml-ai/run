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
export async function compatibilityRuntime(
  t: any,
  respond: any,
  env: Record<string, string> = {},
  tenantsFile?: any,
  _options?: any,
) {
  const root = await mkdtemp(join(tmpdir(), 'camelrun-proto-sdk-files-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const model = await fakeModel(t, respond);
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
  const server = await startFixture({
    token: OPERATOR,
    tenant: "alice",
    modelURL: env.AGENT_BASE_URL ?? model.url,
    tenants,
    vars: { ...env, ...(tenantsFile ? { AGENT_TENANTS_JSON: JSON.stringify(tenantsFile), TEST_DECISION_KEYS: JSON.stringify({ tenants: Object.fromEntries(Object.entries(tenantsFile.tenants ?? {}).map(([id, value]: [string, any]) => [id, { apiKeys: value.apiKeys, platformKeys: value.platformKeys }])), platformKeys: tenantsFile.platformKeys }) } : {}), MODEL: env.AGENT_MODEL ?? "openai/gpt-4o-mini" },
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
