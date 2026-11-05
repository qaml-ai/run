import { z } from "zod";
import { keyServices, type KeyServices, type SecurityEnv } from "./security-services.ts";
import { KeyInput, TenantInput, TenantLimitsInput } from "./security-inputs.ts";
import { listProviders, providerInfo } from "./key-catalog.ts";
import { AWS_REGION, checkScope, scopeEntry } from "./key-scopes.ts";
import { providerInput } from "./model-providers.ts";
import { checkProviderKey } from "./key-check.ts";
import { HttpError } from "./errors.ts";
import { body } from "./validation.ts";
import { Webhooks } from "./webhook-policy.ts";

export type KeyPrincipal = { tenantId: string; kind: string; scopes?: string[]; tokenId?: string; principal?: { tokenId?: string } };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function input<T>(request: Request, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => i.message).join("; "));
  return parsed.data;
}
function operatorOnly(env: SecurityEnv, auth: KeyPrincipal) {
  if (auth.kind !== "operator" || !(env.AGENT_BILLING_ADMINS ?? env.BILLING_ADMINS ?? "").split(",").map(value => value.trim()).includes(auth.tenantId)) throw new HttpError(403, "Only the platform operator can manage tenants");
}

export async function keyRoutes(request: Request, env: SecurityEnv, auth: KeyPrincipal, supplied?: KeyServices): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  if (!/^\/v1\/(providers(?:\/|$)|key-scopes(?:\/|$)|tokens(?:\/|$)|api-keys(?:\/|$)|tenants(?:\/|$))/.test(path)) return;
  const { accounts, keyScopes, modelProviders, outbound } = supplied ?? await keyServices(env), tenant = auth.tenantId;
  if (auth.kind === "oauth" && !(path === "/v1/providers" && request.method === "GET")) throw new HttpError(403, "An OAuth access token works with agents only: use an API token or the console");
  if (path === "/v1/tokens" || path === "/v1/api-keys") {
    if (request.method === "GET") return json(await accounts.listTokens(tenant));
    if (request.method === "POST") {
      const { name } = await input(request, z.object({ name: z.string().trim().min(1).max(80) }));
      return json(await accounts.createToken(tenant, name), 201);
    }
  }
  const token = /^\/v1\/(?:tokens|api-keys)\/([^/]+)$/.exec(path);
  if (token && request.method === "DELETE") {
    const id = decodeURIComponent(token[1]);
    if (auth.kind === "api" && (auth.principal?.tokenId ?? auth.tokenId) === id) throw new HttpError(400, "A token cannot revoke itself; use another token or the console");
    if (!await accounts.revokeToken(tenant, id)) throw new HttpError(404, "Unknown token");
    const left = accounts.canStoreKeys ? await new Webhooks({ db: accounts.db, accounts, outbound }).setBy(tenant, `token:${id}`) : [];
    return json({ revoked: true, left });
  }
  if (path === "/v1/providers" && request.method === "GET") {
    const keys = new Map((await accounts.keyStatus(tenant)).map(status => [status.provider, status]));
    return json([...listProviders().map(provider => ({ ...provider, key: keys.get(provider.id) ?? null })), ...await modelProviders.list(tenant)]);
  }
  const builtin = /^\/v1\/providers\/([^/]+)\/key$/.exec(path);
  if (builtin) {
    const info = providerInfo(builtin[1]);
    if (!info) throw new HttpError(404, `Unknown provider ${builtin[1]}; see GET /v1/providers`);
    if (request.method === "DELETE") {
      if (!await accounts.deleteKey(tenant, info.id)) throw new HttpError(404, `No ${info.id} key set by this tenant`);
      return json({ deleted: true });
    }
    if (request.method === "PUT") {
      if (!info.apiKey) throw new HttpError(400, `${info.id} needs ${info.requires}, not just an API key; it is not supported yet`);
      if (!accounts.canStoreKeys) throw new HttpError(503, "This runtime is not configured to store provider keys");
      const { apiKey, region, verify } = await input(request, KeyInput);
      if (info.id === "amazon-bedrock" && (region === undefined || !AWS_REGION.test(region))) throw new HttpError(400, "amazon-bedrock needs its region, an AWS region like us-west-2: { apiKey, region }");
      if (info.id !== "amazon-bedrock" && region !== undefined) throw new HttpError(400, "region is only for amazon-bedrock");
      const verification = verify === false || env.TEST_MODE === "1" ? { status: "unverified" as const, detail: "Verification skipped" }
        : info.kind !== "model" ? { status: "unverified" as const, detail: `${info.id} has no free way to check a key; the first ${info.kind === "search" ? "web_search" : info.kind === "speech" ? "voice session using it" : "rendered web_fetch"} will` }
        : await checkProviderKey(info.id, apiKey);
      if (verification.status === "invalid") throw new HttpError(422, verification.detail);
      await accounts.setKey(tenant, info.id, apiKey, region);
      return json({ provider: info.id, last4: apiKey.slice(-4), ...(region ? { region } : {}), verification });
    }
  }
  const scope = /^\/v1\/key-scopes\/([^/]+)(?:\/(providers|model-providers)(?:\/([^/]+))?)?$/.exec(path);
  if (scope) {
    const name = checkScope(decodeURIComponent(scope[1])), provider = scope[3] && decodeURIComponent(scope[3]);
    if (!scope[2]) {
      if (request.method === "GET") return json(await keyScopes.status(tenant, name));
      if (request.method === "DELETE") {
        await keyScopes.delete(tenant, name); await modelProviders.deleteScope(tenant, name);
        return json({ deleted: true });
      }
    }
    if (scope[2] === "model-providers") {
      if (!provider && request.method === "GET") return json(await modelProviders.list(tenant, name));
      if (provider && request.method === "PUT") return json(await modelProviders.set(tenant, provider, providerInput(await body(request, 1024 * 1024)), Object.keys(accounts.tenants.modelEndpoints(tenant) ?? {}), name));
      if (provider && request.method === "DELETE") {
        if (!await modelProviders.delete(tenant, provider, name)) throw new HttpError(404, `No provider ${provider} in this key scope`);
        return json({ deleted: true });
      }
    }
    if (scope[2] === "providers" && provider) {
      if (request.method === "PUT") return json(await keyScopes.set(tenant, name, provider, scopeEntry(provider, await body(request, 64 * 1024), await modelProviders.has(tenant, provider, name))));
      if (request.method === "DELETE") {
        if (!await keyScopes.delete(tenant, name, provider)) throw new HttpError(404, `No ${provider} entry in this key scope`);
        return json({ deleted: true });
      }
    }
  }
  const custom = /^\/v1\/providers\/([^/]+)$/.exec(path);
  if (custom) {
    if (request.method === "PUT") return json(await modelProviders.set(tenant, custom[1], providerInput(await body(request, 1024 * 1024)), Object.keys(accounts.tenants.modelEndpoints(tenant) ?? {})));
    if (request.method === "DELETE") {
      if (!await modelProviders.delete(tenant, custom[1])) throw new HttpError(404, `No provider ${custom[1]} of this tenant's; built-in providers' keys are at /v1/providers/{provider}/key`);
      return json({ deleted: true });
    }
  }
  if (path === "/v1/tenants") {
    operatorOnly(env, auth);
    if (request.method === "GET") {
      const login = url.searchParams.get("login");
      if (login === null) throw new HttpError(400, "login is required");
      const { rows } = await accounts.db.query(`select t.id, t.github, t.google_email, p.email, t.created_at from tenants t left join tenant_passwords p on p.tenant = t.id
        where t.id = lower($1) or lower(t.github) = lower($1) or lower(t.google_email) = lower($1) or p.email = lower(trim($1)) order by t.created_at`, [login]);
      return json(rows.map(row => ({ tenant: row.id, github: row.github, googleEmail: row.google_email, email: row.email, createdAt: Number(row.created_at) })));
    }
    if (request.method === "POST") {
      const { id, tokenName } = await input(request, TenantInput);
      if (accounts.tenants.has(id)) throw new HttpError(409, `${id} is an admin tenant`);
      const { rowCount } = await accounts.db.query("insert into tenants (id, created_at) select $1, $2 where not exists (select 1 from account_deletions where tenant = $1) on conflict do nothing", [id, Date.now()]);
      if (!rowCount) throw new HttpError(409, `Tenant ${id} already exists or was deleted`);
      return json({ tenant: id, token: await accounts.createToken(id, tokenName) }, 201);
    }
  }
  const limits = /^\/v1\/tenants\/([^/]+)\/limits$/.exec(path);
  if (limits && request.method === "PUT") {
    operatorOnly(env, auth);
    const target = limits[1];
    if (accounts.tenants.has(target)) throw new HttpError(409, `${target} is an admin tenant: set its limits in the tenants file`);
    const value = await input(request, TenantLimitsInput);
    const set: Record<string, number> = {}, removed = ["codeEngine"];
    for (const [key, setting] of Object.entries(value)) {
      const stored = key === "maxStorageGb" ? "maxStorageBytes" : key;
      if (setting === null) removed.push(stored);
      else if (setting !== undefined) set[stored] = key === "maxStorageGb" ? Math.round(setting * 1e9) : setting;
    }
    const { rows: [row] } = await accounts.db.query("update tenants set limits = (limits - $3::text[]) || $2::jsonb where id = $1 returning limits", [target, JSON.stringify(set), removed]);
    if (!row) throw new HttpError(404, `Unknown tenant ${target}`);
    accounts.billing.forgetLimits(target);
    const { maxStorageBytes, ...rest } = row.limits;
    return json({ tenant: target, limits: { ...rest, ...(typeof maxStorageBytes === "number" ? { maxStorageGb: maxStorageBytes / 1e9 } : {}) } });
  }
}
