import { Vault, decodeVaultPath, type SecretInput } from "../../../src/core/vault.ts";
import { keyServices, type SecurityEnv } from "./security-services.ts";
import { withSql, type PostgresEnv } from "./postgres.ts";
import { HttpError } from "./errors.ts";
export async function workerVault(env: Omit<SecurityEnv, "HYPERDRIVE"> & Partial<PostgresEnv>) {
  if (!env.HYPERDRIVE) throw new HttpError(503, "Vault database is unavailable");
  const configured = env as SecurityEnv & PostgresEnv;
  const { accounts } = await keyServices(configured);
  return new Vault({ query: (text, values) => withSql(configured, sql => sql.query(text, values)) as never }, { canStore: accounts.canStoreKeys, seal: (ctx,text) => accounts.seal(ctx,text), unseal: (ctx,sealed) => accounts.unseal(ctx,sealed) });
}
export async function vaultRoutes(request: Request, env: SecurityEnv & PostgresEnv, auth: { tenantId: string; kind: string }) {
  const match = /^\/v1\/(?:workspaces\/([^/]+)\/)?secrets(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
  if (!match) return undefined;
  if (auth.kind === "oauth") throw new HttpError(403, "Use an API token or the console for vault secrets");
  const workspace = decodeVaultPath(match[1] ?? ""), name = decodeVaultPath(match[2] ?? ""), vault = await workerVault(env);
  try {
    let result: unknown;
    if (request.method === "GET" && !name) result = await vault.list(auth.tenantId, workspace);
    else if (request.method === "DELETE" && name) { await vault.remove(auth.tenantId,name,workspace); result = { deleted: true }; }
    else if (["POST", "PATCH"].includes(request.method) && name) {
      const text = await request.text(); if (text.length > 32*1024) throw new HttpError(413,"Request too large");
      let input: SecretInput; try { input = JSON.parse(text); } catch { throw new HttpError(400,"Invalid JSON"); }
      result = await vault.put(auth.tenantId,name,input,workspace,request.method === "POST");
    } else throw new HttpError(404,"Not found");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const e = error as Error & {status?:number};
    if (e.status) throw new HttpError(e.status,e.message);
    throw error;
  }
}
