import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import { resolveProviderKey, type ProviderKeyEnv } from './model-credentials.ts';
import { PublicOutbound } from './public-outbound.ts';
import { builtinDefinitions } from './web-definitions.ts';
import { WebSearch, searchProvidersFromEnvironment } from './web-search-policy.ts';
import { XSearch } from './x-search-policy.ts';
import { WebRender } from './web-render-policy.ts';
import { webFetch } from './web-fetch-policy.ts';
import { DEFAULT_PRICING } from '../../../src/pricing.ts';
import { withSql } from './postgres.ts';
import { HttpError } from './errors.ts';
import type { Outbound, UsageRecord, WebFiles } from './web-policy-host.ts';

export type BuiltinScope = { tenant: string; agent: string; builtins?: string[]; webSearch?: { providers: string[] }; keyScope?: string; files?: WebFiles };
export type BuiltinEnv = ProviderKeyEnv & { TEST_MODEL?: string; AGENT_EXA_SEARCH_URL?: string; AGENT_BRAVE_SEARCH_URL?: string; AGENT_PARALLEL_SEARCH_URL?: string; AGENT_WEB_SEARCH_PROVIDERS?: string; AGENT_X_SEARCH_URL?: string; AGENT_FIRECRAWL_SCRAPE_URL?: string };
export type BuiltinHost = { outbound?: Outbound; key?: (scope: BuiltinScope, provider: string) => Promise<{ key: string; platform: boolean } | undefined>; record?: (scope: BuiltinScope, usage: UsageRecord) => Promise<void> };

/** Own-key searches are usage, not a platform credit debit. */
async function recordUsage(env: BuiltinEnv, scope: BuiltinScope, usage: UsageRecord) {
  if (usage.platform) throw new HttpError(503, 'Platform web usage billing is not configured');
  await withSql(env, sql => sql.query(`insert into usage(tenant,day,model,responses,input,output,cost,platform_responses,platform_cost) values($1,$2,$3,1,$4,$5,$6,0,0)
    on conflict(tenant,day,model) do update set responses=usage.responses+1,input=usage.input+excluded.input,output=usage.output+excluded.output,cost=usage.cost+excluded.cost`,
  [scope.tenant, new Date().toISOString().slice(0, 10), `${usage.provider}/${usage.model}`, usage.usage.input ?? 0, usage.usage.output ?? 0, usage.usage.cost.total]));
}

/** Register only enabled web capabilities; source policy owns validation, routing and budgets. */
export async function agentBuiltins(env: BuiltinEnv, context: () => Promise<BuiltinScope>, host: BuiltinHost = {}): Promise<ToolRegistration[]> {
  const initial = await context();
  const testMode = env.TEST_MODEL === '1' && env.TEST_MODE === '1';
  const outbound = host.outbound ?? new PublicOutbound({ testMode });
  const settings = testMode ? env : { AGENT_WEB_SEARCH_PROVIDERS: env.AGENT_WEB_SEARCH_PROVIDERS };
  const providers = searchProvidersFromEnvironment(settings as never);
  return builtinDefinitions(initial.builtins).map(definition => {
    const check = compile(definition.parameters as never);
    return defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, replay: 'safe', execute: async (args: Record<string, unknown>, _api, call) => {
      if (!(check.check as (value: unknown) => boolean)(args)) throw new HttpError(400, `Invalid ${definition.name} arguments`);
      const scope = await context(), usages: UsageRecord[] = [];
      const key = async (_tenant: string, provider: string) => {
        if (host.key) return host.key(scope, provider);
        const credential = await resolveProviderKey(env, scope.tenant, provider, scope.keyScope);
        return credential?.apiKey ? { key: credential.apiKey, platform: credential.platform } : undefined;
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
        for (const usage of usages) await (host.record ?? ((scope, usage) => recordUsage(env, scope, usage)))(scope, usage);
      }
    } });
  });
}
