import { defineTool, type ToolRegistration, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import { resolveProviderKey, type ProviderKeyEnv } from './model-credentials.ts';
import { PublicOutbound } from './public-outbound.ts';
import { builtinDefinitions } from './web-definitions.ts';
import { WebSearch, searchProvidersFromEnvironment } from './web-search-policy.ts';
import { XSearch } from './x-search-policy.ts';
import { WebRender } from './web-render-policy.ts';
import { webFetch } from './web-fetch-policy.ts';
import { DEFAULT_PRICING } from '../../../src/pricing.ts';
import { transaction } from './postgres.ts';
import { HttpError } from './errors.ts';
import type { Outbound, UsageRecord, WebFiles } from './web-policy-host.ts';
import { admitAuxiliaryUsage, recordAuxiliaryUsage } from './auxiliary-usage.ts';

export type BuiltinScope = { tenant: string; agent: string; requestId?: string; spendLimit?: number; callId?: string; startedAt?: number; builtins?: string[]; webSearch?: { providers: string[] }; keyScope?: string; files?: WebFiles };
export type BuiltinEnv = ProviderKeyEnv & { TEST_MODEL?: string; AGENT_EXA_SEARCH_URL?: string; AGENT_BRAVE_SEARCH_URL?: string; AGENT_PARALLEL_SEARCH_URL?: string; AGENT_WEB_SEARCH_PROVIDERS?: string; AGENT_X_SEARCH_URL?: string; AGENT_FIRECRAWL_SCRAPE_URL?: string };
export type BuiltinHost = { outbound?: Outbound; key?: (scope: BuiltinScope, provider: string) => Promise<{ key: string; platform: boolean } | undefined>; admit?: (scope: BuiltinScope, platform: boolean) => Promise<void>; record?: (scope: BuiltinScope, usage: UsageRecord) => Promise<void> };

/** Own-key searches are usage, not a platform credit debit. */
async function recordUsage(env: BuiltinEnv, scope: BuiltinScope, usage: UsageRecord) {
  if (usage.platform) throw new HttpError(503, 'Platform web usage billing is not configured');
  await transaction(env, async sql => {
    if (!scope.callId || scope.startedAt === undefined) throw new HttpError(503, 'Web call identity is unavailable');
    if (!await recordAuxiliaryUsage(sql, { tenant: scope.tenant, agent: scope.agent, requestId: scope.requestId, callId: scope.callId, startedAt: scope.startedAt, kind: usage.model as 'web_search' | 'x_search' | 'web_fetch' }, { costUsd: usage.usage.cost.total, provider: usage.provider, model: usage.model })) return;
    await sql.query(`insert into usage(tenant,day,model,responses,input,output,cost,platform_responses,platform_cost) values($1,$2,$3,1,$4,$5,$6,0,0)
    on conflict(tenant,day,model) do update set responses=usage.responses+1,input=usage.input+excluded.input,output=usage.output+excluded.output,cost=usage.cost+excluded.cost`,
    [scope.tenant, new Date().toISOString().slice(0, 10), `${usage.provider}/${usage.model}`, usage.usage.input ?? 0, usage.usage.output ?? 0, usage.usage.cost.total]);
  });
}

/** Register only enabled web capabilities; source policy owns validation, routing and budgets. */
export async function agentBuiltins(env: BuiltinEnv, context: (api?: ToolExecutionApi) => Promise<BuiltinScope>, host: BuiltinHost = {}): Promise<ToolRegistration[]> {
  const initial = await context();
  const testMode = env.TEST_MODEL === '1' && env.TEST_MODE === '1';
  const outbound = host.outbound ?? new PublicOutbound({ testMode });
  const settings = testMode ? env : { AGENT_WEB_SEARCH_PROVIDERS: env.AGENT_WEB_SEARCH_PROVIDERS };
  const providers = searchProvidersFromEnvironment(settings as never);
  return builtinDefinitions(initial.builtins).map(definition => {
    const check = compile(definition.parameters as never);
    return defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, replay: 'safe', execute: async (args: Record<string, unknown>, api, call) => {
      if (!(check.check as (value: unknown) => boolean)(args)) throw new HttpError(400, `Invalid ${definition.name} arguments`);
      const scope = { ...await context(api), callId: `${api.conversationId}:${api.taskId}:${api.callId}`, startedAt: Date.now() }, usages: UsageRecord[] = [];
      const key = async (_tenant: string, provider: string) => {
        const credential = host.key ? await host.key(scope, provider) : await resolveProviderKey(env, scope.tenant, provider, scope.keyScope);
        const found = credential && ('key' in credential ? credential : credential.apiKey ? { key: credential.apiKey, platform: credential.platform } : undefined);
        if (found) await (host.admit ? host.admit(scope, found.platform) : admitAuxiliaryUsage(env, scope, found.platform));
        return found;
      };
      const record = (_tenant: string, _agent: string, usage: UsageRecord) => { usages.push(usage); };
      const signal = call.abortSignal ?? new AbortController().signal;
      try {
        if (definition.name === 'web_fetch') {
          const render = new WebRender({ outbound, key, price: DEFAULT_PRICING.webRender, ...(testMode && env.AGENT_FIRECRAWL_SCRAPE_URL ? { endpoint: env.AGENT_FIRECRAWL_SCRAPE_URL } : {}), onRender: record });
          const result = await webFetch({ outbound, render }, scope, String(args.url), args.maxCharacters as number ?? 20_000, signal);
          return { output: result.content, details: result.structuredContent as never };
        }
        const value = definition.name === 'web_search'
          ? await new WebSearch({ outbound, ...providers, key, price: provider => DEFAULT_PRICING.webSearch[provider], onSearch: record }).search({ ...scope, providers: scope.webSearch?.providers }, args, signal)
          : await new XSearch({ outbound, key, ...(testMode && env.AGENT_X_SEARCH_URL ? { endpoint: env.AGENT_X_SEARCH_URL } : {}), onSearch: record }).search(scope, args, signal);
        return { output: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
      } finally {
        for (const [index, usage] of usages.entries()) await (host.record ?? ((scope, usage) => recordUsage(env, scope, usage)))({ ...scope, callId: `${scope.callId}:${index}` }, usage);
      }
    } });
  });
}
