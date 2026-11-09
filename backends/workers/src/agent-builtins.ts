import { agentMonitorTools, type MonitorToolsHost } from './agent-monitors.ts';
import type { Networking } from "../../../src/core/vault.ts";
import { defineTool, type ToolRegistration, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { compile } from '@earendil-works/pi-schema';
import { resolveProviderKey, type ProviderKeyEnv } from './model-credentials.ts';
import { PublicOutbound } from './public-outbound.ts';
import { builtinDefinitions } from './web-definitions.ts';
import { WebSearch, searchProvidersFromEnvironment } from './web-search-policy.ts';
import { XSearch } from './x-search-policy.ts';
import { WebRender } from './web-render-policy.ts';
import { webFetch } from './web-fetch-policy.ts';
import { pricingFromEnvironment } from '../../../src/pricing.ts';
import { HttpError } from './errors.ts';
import type { Outbound, UsageRecord, WebFiles } from './web-policy-host.ts';
import { agentScheduleTools, type ScheduleToolsHost } from './agent-schedules.ts';
import { admitWebUsage, recordWebUsage } from './web-billing.ts';
import type { KeyEnv } from './security-services.ts';
import { toolResult } from './attached-tools.ts';
import type { WebhookEnv } from './webhooks.ts';

export type BuiltinScope = { networking?: Networking; tenant: string; agent: string; requestId?: string; spendLimit?: number; callId?: string; startedAt?: number; builtins?: string[]; webSearch?: { providers: string[] }; keyScope?: string; identity?: { subject?: string; context?: Record<string, unknown> }; actor?: string; bucket?: string; files?: WebFiles };
export type BuiltinEnv = ProviderKeyEnv & KeyEnv & WebhookEnv & { TEST_MODEL?: string; AGENT_OUTBOUND_ALLOW_HTTP?: string; AGENT_OUTBOUND_ALLOW_CIDRS?: string; AGENT_OUTBOUND_BLOCK_CIDRS?: string; AGENT_EXA_SEARCH_URL?: string; AGENT_BRAVE_SEARCH_URL?: string; AGENT_PARALLEL_SEARCH_URL?: string; AGENT_WEB_SEARCH_PROVIDERS?: string; AGENT_XAI_RESPONSES_URL?: string; AGENT_X_SEARCH_URL?: string; AGENT_FIRECRAWL_SCRAPE_URL?: string };
export type BuiltinHost = { outbound?: Outbound; providerOutbound?: Outbound; key?: (scope: BuiltinScope, provider: string) => Promise<{ key: string; platform: boolean } | undefined>; admit?: (scope: BuiltinScope, platform: boolean) => Promise<void>; record?: (scope: BuiltinScope, usage: UsageRecord) => Promise<void>; schedules?: ScheduleToolsHost; monitors?: MonitorToolsHost };

/** Register only enabled web capabilities; source policy owns validation, routing and budgets. */
export async function agentBuiltins(env: BuiltinEnv, context: (api?: ToolExecutionApi) => Promise<BuiltinScope>, host: BuiltinHost = {}): Promise<ToolRegistration[]> {
  const initial = await context();
  const testMode = env.TEST_MODEL === '1' && env.TEST_MODE === '1';
  const cidrs = (value?: string) => value?.split(',').map(value => value.trim()).filter(Boolean);
  const outbound = host.outbound ?? new PublicOutbound({ networking: initial.networking, allowHttp: testMode && env.AGENT_OUTBOUND_ALLOW_HTTP === 'true', allow: testMode ? cidrs(env.AGENT_OUTBOUND_ALLOW_CIDRS) ?? [] : [], block: cidrs(env.AGENT_OUTBOUND_BLOCK_CIDRS) });
  const providerOutbound = host.providerOutbound ?? host.outbound ?? new PublicOutbound({ allowHttp: testMode && env.AGENT_OUTBOUND_ALLOW_HTTP === 'true', allow: testMode ? cidrs(env.AGENT_OUTBOUND_ALLOW_CIDRS) ?? [] : [], block: cidrs(env.AGENT_OUTBOUND_BLOCK_CIDRS) });
  const settings = testMode ? env : { AGENT_WEB_SEARCH_PROVIDERS: env.AGENT_WEB_SEARCH_PROVIDERS };
  const providers = searchProvidersFromEnvironment(settings as never);
  const pricingEnv = Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')) as NodeJS.ProcessEnv;
  const pricing = pricingFromEnvironment(pricingEnv);
  return [...agentScheduleTools(initial.builtins, host.schedules), ...agentMonitorTools(initial.builtins, host.monitors), ...builtinDefinitions(initial.builtins).map(definition => {
    const check = compile(definition.parameters as never);
    return defineTool({ name: definition.name, description: definition.description, parameters: definition.parameters as never, structuredOutputSchema: {}, replay: 'safe', execute: async (args: Record<string, unknown>, api, call) => {
      if (!(check.check as (value: unknown) => boolean)(args)) throw new HttpError(400, `Invalid ${definition.name} arguments`);
      const scope = { ...await context(api), callId: `${api.conversationId}:${api.taskId}:${api.callId}`, startedAt: Date.now() }, usages: UsageRecord[] = [];
      const key = async (_tenant: string, provider: string) => {
        const credential = host.key ? await host.key(scope, provider) : await resolveProviderKey(env, scope.tenant, provider, scope.keyScope);
        const found = credential && ('key' in credential ? credential : credential.apiKey ? { key: credential.apiKey, platform: credential.platform } : undefined);
        if (found) await (host.admit ? host.admit(scope, found.platform) : admitWebUsage(env, scope, found.platform));
        return found;
      };
      const record = (_tenant: string, _agent: string, usage: UsageRecord) => { usages.push(usage); };
      const signal = call.abortSignal ?? new AbortController().signal;
      try {
        if (definition.name === 'web_fetch') {
          const render = new WebRender({ outbound: providerOutbound, targetOutbound: outbound, key, price: pricing.webRender, ...(testMode && env.AGENT_FIRECRAWL_SCRAPE_URL ? { endpoint: env.AGENT_FIRECRAWL_SCRAPE_URL } : {}), onRender: record });
          const result = await webFetch({ outbound, render }, scope, String(args.url), args.maxCharacters as number ?? 20_000, signal);
          return toolResult(result);
        }
        const value = definition.name === 'web_search'
          ? await new WebSearch({ outbound: providerOutbound, ...providers, key, price: provider => pricing.webSearch[provider], onSearch: record }).search({ ...scope, providers: scope.webSearch?.providers }, args, signal)
          : await new XSearch({ outbound: providerOutbound, key, ...(testMode && (env.AGENT_XAI_RESPONSES_URL ?? env.AGENT_X_SEARCH_URL) ? { endpoint: env.AGENT_XAI_RESPONSES_URL ?? env.AGENT_X_SEARCH_URL } : {}), onSearch: record }).search(scope, args, signal);
        return toolResult({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
      } catch (error) {
        if (signal.aborted) throw error;
        return { output: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      } finally {
        for (const [index, usage] of usages.entries()) await (host.record ?? ((scope, usage) => recordWebUsage(env, scope, usage)))({ ...scope, callId: `${scope.callId}:${index}` }, usage);
      }
    } });
  })];
}
