import { HttpError } from "./errors.ts";
import { body } from "./validation.ts";
import { transaction, withSql } from "./postgres.ts";
import { providerInput, providerName, shownModel, MAX_PROVIDERS } from "./provider-policy.ts";
import { openProviderSecret, sealProviderSecret, resolveCustomProviders, type ProviderKeyEnv, type Sealed } from "./model-credentials.ts";
import { modelInfo, listProviders } from "./catalog-policy.ts";
import { resolveModel } from "./model-policy.ts";
import { modelCatalog } from "./model.ts";
import type { AuthContext } from "./control.ts";
import { sourceUrl } from "./tool-sources.ts";

const reply = (value: unknown) => Response.json(value, { headers:{"cache-control":"no-store"} });
const aad = (tenant: string, name: string, scope: string) => scope ? `model-provider:${tenant}:scope:${scope}:${name}` : `model-provider:${tenant}:${name}`;
type Row = { name:string; config:{ type:string; baseUrl:string; models:Parameters<typeof shownModel>[0][]; auth?:string; headers?:string[] }; sealed:Sealed; last4:string; set_at:number|string };
const view = (row: Row) => ({
  id:row.name, kind:"model", models:row.config.models.length, apiKey:true,
  key:row.last4 ? {provider:row.name,source:"tenant",last4:row.last4,setAt:Number(row.set_at)} : null,
  custom:{ type:row.config.type,baseUrl:row.config.baseUrl,auth:row.config.type === "anthropic-messages" && row.config.auth !== "bearer" ? "x-api-key" : "bearer", ...(row.config.headers?.length ? {headers:row.config.headers} : {}),models:row.config.models.map(shownModel) },
});
export async function customProviderList(env: ProviderKeyEnv, tenant: string, scope = "") {
  return (await withSql(env, sql => sql.query<Row>("select name,config,sealed,last4,set_at from model_providers where tenant=$1 and scope=$2 order by name", [tenant,scope]))).rows.map(view);
}

/** Custom provider declarations and secrets use the existing relational schema, independently of live agents. */
export async function providerRoutes(request: Request, env: ProviderKeyEnv & {MODEL:string;TEST_MODEL?:string}, auth: AuthContext): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  const tenant = auth.tenantId;
  if (path === "/v1/models" && request.method === "GET") {
    const provider = url.searchParams.get("provider") ?? undefined;
    const custom = await resolveCustomProviders(env,tenant,url.searchParams.get("keyScope") ?? undefined);
    const declared = Object.entries(custom ?? {}).filter(([name]) => !provider || name===provider).flatMap(([name,entry]) => entry.models.map(model => ({...modelInfo(resolveModel(`${name}/${model.id}`,undefined,custom)),available:true})));
    const keys = new Set((await withSql(env,sql => sql.query("select provider from provider_keys where tenant=$1",[tenant]))).rows.map(row=>row.provider));
    const catalog = modelCatalog(env,provider).map(model => ({...model,available: env.TEST_MODEL==="1" || keys.has("routes" in model && Array.isArray(model.routes) ? String(model.routes[0]).split("/")[0] : model.provider)}));
    const models = [...declared,...catalog];
    return reply(url.searchParams.get("available")==="true" ? models.filter(model=>model.available) : models);
  }
  const custom = /^\/v1\/providers(?:\/([^/]+))?$/.exec(path);
  const scoped = /^\/v1\/key-scopes\/([^/]+)\/model-providers(?:\/([^/]+))?$/.exec(path);
  if (!custom && !scoped) return;
  const scope = scoped ? decodeURIComponent(scoped[1]) : "";
  if (scope && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(scope)) throw new HttpError(400, "keyScope must be 1–100 letters, digits, '_', '.' or '-', starting with a letter or digit");
  const name = (scoped ? scoped[2] : custom?.[1]) && decodeURIComponent((scoped ? scoped[2] : custom![1])!);
  if (!name && request.method === "GET") {
    const own = await customProviderList(env,tenant,scope);
    if (scoped) return reply(own);
    const keys = (await withSql(env, sql => sql.query("select provider,last4,set_at,region from provider_keys where tenant=$1", [tenant]))).rows;
    return reply([...listProviders().map(info => ({...info,key:(() => { const row=keys.find(key => key.provider===info.id); return row ? {provider:info.id,source:"tenant",last4:row.last4,setAt:Number(row.set_at),...(row.region?{region:row.region}:{})} : null; })()})), ...own]);
  }
  if (!name) return;
  if (request.method === "DELETE") {
    const deleted = await transaction(env, async sql => {
      const result = await sql.query("delete from model_providers where tenant=$1 and scope=$2 and name=$3", [tenant,scope,name]);
      if (result.rowCount && !scope) await sql.query("delete from key_scope_providers where tenant=$1 and provider=$2",[tenant,name]);
      return !!result.rowCount;
    });
    if (!deleted) throw new HttpError(404, `No provider ${name} ${scope ? "in this key scope" : "of this tenant's"}`);
    return reply({deleted:true});
  }
  if (request.method !== "PUT") return;
  providerName(name);
  const input = providerInput(await body(request, 1024 * 1024));
  // The per-request transport checks it again and disables redirects. Local fixtures are opt-in only.
  sourceUrl(input.baseUrl, env);
  return reply(await transaction(env, async sql => {
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`model-providers:${tenant}:${scope}`]);
    const rows = (await sql.query<Row>("select name,config,sealed,last4,set_at from model_providers where tenant=$1 and scope=$2", [tenant,scope])).rows;
    const current = rows.find(row => row.name===name);
    if (!current && rows.length >= MAX_PROVIDERS) throw new HttpError(400, `A ${scope ? "key scope" : "tenant"} can have at most ${MAX_PROVIDERS} providers`);
    const kept = current ? JSON.parse(await openProviderSecret(env,aad(tenant,name,scope),current.sealed)) as {apiKey?:string;headers?:Record<string,string>} : {};
    const apiKey = input.apiKey === undefined ? kept.apiKey : input.apiKey ?? undefined;
    const headers = input.headers === undefined ? kept.headers : input.headers && Object.keys(input.headers).length ? input.headers : undefined;
    const config = {type:input.type,baseUrl:input.baseUrl,models:input.models,...(headers?{headers:Object.keys(headers)}:{}),...(input.auth?{auth:input.auth}:{})};
    const sealed = await sealProviderSecret(env,aad(tenant,name,scope),JSON.stringify({...(apiKey?{apiKey}:{}),...(headers?{headers}:{})}));
    const row = {name,config,sealed,last4:apiKey?.slice(-4)??"",set_at:Date.now()};
    await sql.query("insert into model_providers(tenant,scope,name,config,sealed,last4,set_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(tenant,scope,name) do update set config=excluded.config,sealed=excluded.sealed,last4=excluded.last4,set_at=excluded.set_at", [tenant,scope,name,config,sealed,row.last4,row.set_at]);
    return view(row);
  }));
}
