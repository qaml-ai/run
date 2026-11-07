import type { AccountServices } from "./account-services.ts";
import { personal } from "./account-console-auth.ts";
import type { Principal } from "./accounts.ts";
import { AccountDeletions, AGENT_CONCURRENCY, eachLimited } from "./account-deletion.ts";
import { enqueueAccountDeletion } from "./account-deletion-queue.ts";
import { exportAccount } from "./account-export.ts";
import { Directory, type ControlEnv } from "./control.ts";
import { definitionRoutes } from "./definitions.ts";
import { HttpError } from "./errors.ts";
import { readText } from "./account-http.ts";
import { volume, stub, type FileBindings } from "./files.ts";
import type { FileEntry } from "./volume.ts";
import type { Webhooks } from "./webhook-policy.ts";
import type { DeliveryMessage } from "./webhooks.ts";
import { createStripe, type BillingEnv } from "./billing-routes.ts";
import { ComputerService, dropTenantSnapshots, type ComputerEnv } from "./computers/service.ts";
import { transaction } from "./postgres.ts";

export type AccountLifecycleEnv = FileBindings & BillingEnv & {
  WEBHOOKS?: Queue<DeliveryMessage>;
  TENANTS?: { getByName(id: string): { purgeAccountData(): Promise<void> } };
  AGENTS: { getByName(id: string): { fetch(request: Request): Promise<Response>; purgeAccountData(tenant: string, id: string): Promise<void> } };
};
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function removePrefix(env: FileBindings, prefix: string) {
  // Delete every page, including unreferenced objects; R2 is the authority for bytes.
  for (;;) {
    const page = await env.BUCKET.list({ prefix, limit: 1000 });
    if (!page.objects.length) return;
    await env.BUCKET.delete(page.objects.map(object => object.key));
  }
}

export function accountDeletions(env: AccountLifecycleEnv, service: AccountServices, tenantOnly?: string) {
  const db = service.accounts.db;
  const tenantFilter = tenantOnly === undefined ? "" : " and tenant = $1";
  const tenantValues = tenantOnly === undefined ? [] : [tenantOnly];
  return new AccountDeletions({
    db, accounts: service.accounts, stripe: createStripe(env), onlyTenant: tenantOnly,
    // Each channel goes as DELETE /v1/channels/:id takes it: its service torn down, its queue and threads with it.
    channels: { remove: async (tenant, id) => (await (await import("./channels.ts")).workerChannels(env as never)).remove(tenant, id) },
    schedule: tenant => enqueueAccountDeletion(env, tenant),
    storage: { async removeBlobs(prefix) {
      const tenant = prefix.split("/")[1];
      await removePrefix(env, prefix);
      if (prefix.startsWith("chunks/")) {
        await removePrefix(env, `files/${encodeURIComponent(tenant)}/`);
        await removePrefix(env, `images/${encodeURIComponent(tenant)}/`);
      }
    } },
    deleteAgent: async (id, tenant) => {
      const result = await new Directory(env as unknown as ControlEnv, tenant).remove(id);
      if (result && typeof result === "object" && result.failed) throw new HttpError(result.status, result.error);
    },
    purgeAgents: async (owner, limit) => {
      // Directory revokes before the DO drains. Retry an interrupted shutdown
      // before purging journals; the source deletion loop only visits live rows.
      const pending = (await db.query("select id, tenant from agents where revoked and purged_at is null and tenant=$1 order by id limit $2", [owner, limit])).rows;
      await eachLimited(pending, AGENT_CONCURRENCY, async ({ id, tenant }) => {
        const result = await new Directory(env as unknown as ControlEnv, tenant).remove(id);
        if (result && typeof result === "object" && result.failed) throw new HttpError(result.status, result.error);
      });
      const rows = (await db.query("select id, tenant from agents where revoked and purged_at is not null and tenant=$1 order by id limit $2", [owner, limit])).rows;
      await eachLimited(rows, AGENT_CONCURRENCY, async ({ id, tenant }) => {
        await env.AGENTS.getByName(id).purgeAccountData(tenant, id);
        await transaction(db, async sql => {
          // This table is keyed by agent, so the tenant-wide cleanup cannot find it.
          await sql.query("delete from agent_spend_limits where agent = $1", [id]);
          await sql.query("update agents set tenant='', name=id, type='general', model='', expires_at=null, header=$3 where id=$1 and tenant=$2 and revoked", [id, tenant, { version: 3, id, revoked: true, purged: true }]);
        });
      });
      return rows.length;
    },
    removeComputers: async tenant => {
      for (const { agent } of (await db.query("select distinct agent from computer_connections where tenant=$1", [tenant])).rows)
        await new ComputerService(env as unknown as ComputerEnv, tenant).removeAgent(agent);
      // Fork snapshots go too: their rows are deleted with the account, and they are the only handle to them.
      await dropTenantSnapshots(env as unknown as ComputerEnv, tenant);
    },
    flushStorageUsage: async () => {
      for (const { tenant } of (await db.query("select tenant from account_deletions where completed_at is null and not exists (select 1 from agents where agents.tenant=account_deletions.tenant)" + tenantFilter, tenantValues)).rows)
        await env.TENANTS?.getByName(tenant).purgeAccountData();
    },
    volumes: {
      async call(id, tenant) {
        const result = await stub(env, tenant, id).delete();
        await db.query("update volumes set deleted_at=coalesce(deleted_at,$3) where id=$1 and tenant=$2", [id, tenant, Date.now()]);
        return result;
      },
      async purge(id) {
        const row = (await db.query("select tenant from volumes where id=$1", [id])).rows[0];
        if (!row) return;
        await stub(env, row.tenant, id).purgeAccountData(row.tenant);
        await db.query("update volumes set purged_at=$2 where id=$1", [id, Date.now()]);
      },
    },
  });
}

/** Cron repairs the commit-before-enqueue seam and exhausted queue delivery retries. */
export async function resumeAccountDeletions(env: AccountLifecycleEnv, service: AccountServices) {
  const { rows } = await service.accounts.db.query("select tenant from account_deletions where completed_at is null and (claimed_until is null or claimed_until < now()) order by requested_at limit 100");
  for (const { tenant } of rows) await enqueueAccountDeletion(env, tenant);
}

async function exportResponse(env: AccountLifecycleEnv, service: AccountServices, webhooks: Webhooks, tenant: string) {
  const db = service.accounts.db;
  const chunks = exportAccount({
    accounts: service.accounts, oauth: service.oauth, webhooks, journey: service.journey,
    channels: { list: async owner => (await (await import("./channels.ts")).workerChannels(env as never)).list(owner) },
    githubApps: { list: async owner => (await (await import("./github-apps.ts")).workerGitHubApps(env as never)).list(owner) },
    clients: {
      async historyPageFor(id, _tenant, query) {
        const response = await env.AGENTS.getByName(id).fetch(new Request(`https://agent/history?${new URLSearchParams(query as Record<string, string>)}`));
        if (!response.ok) throw new HttpError(response.status, "Agent history is unavailable");
        return response.json() as never;
      },
      async schedulesFor(id) {
        const response = await env.AGENTS.getByName(id).fetch(new Request("https://agent/schedules"));
        if (!response.ok) throw new HttpError(response.status, "Agent schedules are unavailable");
        return response.json() as never;
      },
    },
    definitions: { async list() {
      const response = await definitionRoutes(new Request("https://runtime/v1/definitions"), env as unknown as ControlEnv, { tenantId: tenant, kind: "console", scopes: ["*"] });
      if (!response?.ok) throw new HttpError(response?.status ?? 500, "Definitions are unavailable");
      return response.json() as never;
    } },
    volumes: {
      async list() { return (await db.query("select id from volumes where tenant=$1 and deleted_at is null order by created_at,id", [tenant])).rows; },
      async call(id, owner, action, query) {
        const object = await volume(env, owner, id);
        if (action === "info") return object.info();
        const after = (query as { after?: string })?.after;
        const files = (await object.list()).filter(file => !after || file.path > after);
        return { files: files.slice(0, 500), ...(files.length > 500 ? { next: files[499].path } : {}) };
      },
      async *stream(owner, input) {
        const file = input as FileEntry;
        if (!file.key.startsWith(`files/${encodeURIComponent(owner)}/`)) throw new HttpError(403, "File does not belong to this account");
        const object = await env.BUCKET.get(file.key);
        if (!object) throw new HttpError(503, "File object missing");
        for await (const bytes of object.body) yield bytes;
      },
    },
  }, tenant);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const result = await chunks.next(); if (result.done) controller.close(); else controller.enqueue(result.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await chunks.return(undefined); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/zip", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="camelrun-${tenant}-${new Date().toISOString().slice(0, 10)}.zip"` } });
}

export async function accountLifecycleRoutes(request: Request, env: AccountLifecycleEnv, service: AccountServices, principal: Principal, webhooks: Webhooks, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/account/export" && request.method === "GET") return exportResponse(env, service, webhooks, principal.tenant);
  const operator = /^\/v1\/tenants\/([^/]+)(\/(?:export|deletion))?$/.exec(path);
  if (operator) {
    if (principal.via !== "operator" || !service.billingAdmins.has(principal.tenant)) throw new HttpError(403, "Only the platform operator can manage tenants");
    const tenant = decodeURIComponent(operator[1]);
    if (operator[2] === "/export" && request.method === "GET") {
      if (!await service.accounts.exists(tenant)) throw new HttpError(404, `Unknown tenant ${tenant}`);
      return exportResponse(env, service, webhooks, tenant);
    }
    const deletions = accountDeletions(env, service);
    if (!operator[2] && request.method === "DELETE") {
      const status = await deletions.request(tenant, `operator:${principal.tenant}`);
      return reply(status, 202);
    }
    if (operator[2] === "/deletion" && request.method === "GET") {
      const status = await deletions.status(tenant);
      if (!status) throw new HttpError(404, "No deletion of this tenant");
      return reply(status);
    }
  }
  if (path === "/v1/account" && request.method === "DELETE") {
    if (!personal(principal)) throw new HttpError(403, "An account is deleted from the console, signed in");
    let input: { confirm?: unknown };
    try { input = JSON.parse(await readText(request.body, 4096)); } catch { throw new HttpError(400, "Invalid JSON"); }
    if (input?.confirm !== principal.tenant) throw new HttpError(400, "confirm must be this account's tenant id");
    const deletions = accountDeletions(env, service), status = await deletions.request(principal.tenant, "self");
    return reply(status, 202);
  }
  return null;
}
