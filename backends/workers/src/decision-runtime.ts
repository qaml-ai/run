import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { Decider, DECIDE, decisionRequest, decisionsAnswer, type DecisionCredentials, type DecisionProvider, type Decided } from './decision-policy.ts';
import { openrouterDecisions } from './decision-providers.ts';
import { HttpError } from './errors.ts';
import type { UsageRecord } from './policy-host.ts';
import { body } from './validation.ts';

export interface DecisionContext {
  tenant: string;
  agent?: string;
  requestId?: string;
  callId?: string;
  startedAt?: number;
  keyScope?: string;
  dataCollection?: 'deny' | null;
  budget?: number;
  spendLimit?: number;
  identity?: { subject?: string; context?: Record<string, unknown> };
  actor?: string;
}
/** Match src/client-sessions/tools.ts: a plain agent only gets decide when explicitly requested. */
export function offersDecisions(config: {
  decide?: boolean | null;
  codeMode?: boolean;
  mcp?: { tools?: unknown[] };
  builtins?: unknown[];
  mcpServers?: unknown[];
  openApi?: unknown[];
}) {
  return config.decide !== false && (config.decide === true || config.codeMode !== false ||
    !!(config.mcp?.tools?.length || config.builtins?.length || config.mcpServers?.length || config.openApi?.length));
}
export interface DecisionRuntimeOptions {
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<(DecisionCredentials & { platform: boolean }) | undefined>;
  context(): Promise<DecisionContext>;
  record?(context: DecisionContext, usage: UsageRecord): Promise<void>;
  admit?(context: DecisionContext): Promise<void>;
  provider?: DecisionProvider;
  /** The only non-production endpoint accepted is an explicitly enabled loopback fixture. */
  testUrl?: string;
  testMode?: boolean;
}
function provider(options: DecisionRuntimeOptions): DecisionProvider {
  if (options.provider) return options.provider;
  const base = options.testUrl ?? 'https://openrouter.ai/api/alpha';
  const url = new URL(base);
  if (options.testUrl && !(options.testMode && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new HttpError(400, 'A decision fixture must be loopback HTTP');
  return openrouterDecisions({ baseUrl: base, outbound: { async fetch(url, options) {
    const { secrets, timeoutMs, maxBytes = 1024 * 1024, ...init } = options;
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs ?? 10_000)]);
    const response = await fetch(url, { ...init, signal, redirect: 'manual', headers: { ...Object.fromEntries(new Headers(init.headers)), ...secrets } });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'Decision endpoint redirects are not allowed'); }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body?.cancel(); throw new HttpError(502, 'Decision response is too large'); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (reader) for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) throw new HttpError(502, 'Decision response is too large'); chunks.push(next.value); }
    } finally { await reader?.cancel().catch(() => {}); }
    const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(data, { status: response.status, headers: response.headers });
  } } });
}

/** One instance per agent DO retains the stock decision concurrency and byte gates. */
export class DecisionRuntime {
  readonly decider: Decider;
  private readonly options: DecisionRuntimeOptions;
  constructor(options: DecisionRuntimeOptions) {
    this.options = options;
    this.decider = new Decider({ provider: provider(options), key: options.key });
  }
  async available() { const context = await this.options.context(); return this.decider.available(context.tenant, context.keyScope); }
  async run(input: Record<string, unknown>, signal: AbortSignal, override: Partial<DecisionContext> = {}) {
    const context = { ...await this.options.context(), ...override };
    await this.options.admit?.(context);
    const request = decisionRequest(input);
    const decided: Decided = await this.decider.decide(context, request, signal);
    if (decided.usage) await this.options.record?.(context, { ...decided.usage, ...(context.identity ? { identity: context.identity } : {}), ...(context.actor ? { actor: context.actor } : {}), ...(context.keyScope ? { keyScope: context.keyScope } : {}) });
    return decisionsAnswer(decided, request.batch);
  }
  tool(): ToolRegistration {
    return defineTool({ name: DECIDE.name, description: DECIDE.description, parameters: DECIDE.parameters as never, structuredOutputSchema: {}, replay: 'unsafe', execute: async (args: Record<string, unknown>, api, context) => {
      const result = await this.run(args, context.abortSignal ?? new AbortController().signal, { callId: api.callId, startedAt: Date.now() });
      const text = JSON.stringify(result);
      return { output: [{ type: 'text', text }], structuredOutput: JSON.parse(text) };
    } });
  }
}

/** Auth and financial admission are supplied by the Workers account boundary. */
export async function decisionRoute(request: Request, runtime: DecisionRuntime): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/v1/decisions' || request.method !== 'POST') return null;
  const raw = await body(request, 2 * 1024 * 1024);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Expected an object');
  const { subject, context, actor, keyScope, dataCollection, ...input } = raw as Record<string, unknown>;
  if (subject !== undefined && (typeof subject !== 'string' || !subject || subject.length > 200)) throw new HttpError(400, 'subject must be bounded text');
  if (actor !== undefined && (typeof actor !== 'string' || !actor || actor.length > 200)) throw new HttpError(400, 'actor must be bounded text');
  if (keyScope !== undefined && typeof keyScope !== 'string') throw new HttpError(400, 'keyScope must be text');
  if (dataCollection !== undefined && dataCollection !== 'deny') throw new HttpError(400, 'dataCollection must be deny');
  if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context))) throw new HttpError(400, 'context must be an object');
  const override: Partial<DecisionContext> = { ...(subject !== undefined || context !== undefined ? { identity: { ...(subject !== undefined ? { subject: subject as string } : {}), ...(context !== undefined ? { context: context as Record<string, unknown> } : {}) } } : {}), ...(actor !== undefined ? { actor: actor as string } : {}), ...(keyScope !== undefined ? { keyScope: keyScope as string } : {}), ...(dataCollection === 'deny' ? { dataCollection } : {}) };
  return Response.json(await runtime.run(input, request.signal, override));
}
