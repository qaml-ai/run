import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai/models';
import { ModelAttempts } from './model-attempts.ts';
import { EndUserCredits } from './end-user-credits.ts';
import { attemptStream } from './model-attempt-stream.ts';
import { callFetch, FETCH_APIS } from './model-call-fetch.ts';
import { estimateModelAttempt } from './model-estimate.ts';
import { modelSpendLimit } from './agent-spend.ts';
import type { CreditStop, ModelAttemptEvent, ModelAttemptHook } from './model-attempt.ts';
import { keyServices, providerCredentials, type KeyEnv } from './security-services.ts';
import { PREPARED_MODEL_CREDENTIALS } from './model-request-auth.ts';
import { accountingModel, modelCallKind } from './model-call-context.ts';
import { logUntrustedModelUsage } from './model-usage-log.ts';

export type ModelReceipt = { tenant: string; agent: string; platform: boolean; event: ModelAttemptEvent };
export type ModelBillingContext = {
  tenant: string; agent: string; requestId?: string; subject?: string; bucket?: string; keyScope?: string;
  platform?: boolean; actor?: string; context?: Record<string, unknown>;
  /** This request's budget; the persistent agent budget lives in Postgres. */
  spendLimit?: number;
};
export async function modelAttempts(env: KeyEnv) {
  const { accounts } = await keyServices(env);
  return new ModelAttempts(accounts.db, accounts, fetch, 0, undefined, new EndUserCredits(accounts.db));
}
export async function applyModelReceipt(env: KeyEnv, receipt: ModelReceipt) {
  return (await modelAttempts(env)).event(receipt.tenant, receipt.agent, receipt.platform, receipt.platform, receipt.event);
}

/** Every provider call, including Pi's native compaction, uses the source accounting stream. */
export function meterProvider<P extends Provider<any>>(
  provider: P, env: KeyEnv, context: () => Promise<ModelBillingContext>,
  commit: (receipt: ModelReceipt) => Promise<void>,
  onRefused?: (stop: CreditStop) => Promise<void>,
): P {
  const wrap = (stream: P['stream']) => ((model: Model<any>, transcript: any, options: any = {}) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const identity = await context();
      const service = await modelAttempts(env);
      const credentials = Object.hasOwn(options, PREPARED_MODEL_CREDENTIALS)
        ? options[PREPARED_MODEL_CREDENTIALS]
        : await providerCredentials(await keyServices(env), identity.tenant, model.provider, identity.keyScope);
      // withSettings has already prepared provider-specific request auth. Its
      // sentinels keep anonymous endpoints valid and bearer keys out of Pi's
      // API-key/OAuth heuristics; accounting still fingerprints the real key.
      const preparedKey = options.apiKey;
      const key = credentials?.apiKey ?? (preparedKey === 'keyless' || preparedKey === 'runtime-bearer' ? '' : preparedKey);
      if (credentials) {
        options = { ...options,
          apiKey: preparedKey === 'runtime-bearer' ? preparedKey : credentials.apiKey ?? preparedKey,
          headers: { ...('headers' in credentials ? credentials.headers : {}), ...options.headers },
        };
        if ('baseUrl' in credentials && credentials.baseUrl) model = { ...model, baseUrl: credentials.baseUrl };
      }
      const limit = await modelSpendLimit(service.db, identity) ?? await service.accounts.runLimit(identity.tenant);
      if (limit) throw typeof limit === 'string' ? new Error(limit) : limit;
      const platform = options.endpointIdentity ? false : credentials ? credentials.platform : identity.platform !== false;
      // Provider generation observations, renewal and settlement share the same
      // mutable holds. Finish must follow every preceding accounting write.
      let pending: Promise<unknown> = Promise.resolve();
      const hook: ModelAttemptHook = event => {
        const next = pending.then(async () => {
          if (event.type === 'finish') {
            await commit({ tenant: identity.tenant, agent: identity.agent, platform, event });
            if (platform) logUntrustedModelUsage(identity.tenant, identity.agent, model, event.usage, estimate, event.chars, event.completed);
            return true;
          }
          const attributed = event.type === 'begin' ? { ...event,
            context: { requestId: identity.requestId, actor: identity.actor, keyScope: identity.keyScope,
              ...(identity.subject !== undefined || identity.context !== undefined ? { identity: {
                ...(identity.subject !== undefined ? { subject: identity.subject } : {}),
                ...(identity.context !== undefined ? { context: identity.context } : {}),
              } } : {}) },
            ...(identity.subject ? { endUser: { id: identity.subject, bucket: identity.bucket ?? 'default' } } : {}),
          } : event;
          return service.event(identity.tenant, identity.agent, platform, platform, attributed);
        });
        pending = next.catch(() => {});
        return next;
      };
      const estimate = estimateModelAttempt(model, transcript, options);
      const gateway = !platform && (model.provider === 'cloudflare-ai-gateway' || !!credentials?.baseUrl && model.provider === 'openrouter');
      const billedModel = accountingModel(model, options.endpointIdentity);
      let refusal: Promise<void> | undefined;
      const source = await attemptStream(billedModel, typeof key === 'string' ? key : '', options.modelCallKind ?? modelCallKind(transcript), hook,
        (sink, halt, affordable) => stream(model, transcript, {
          ...options,
          signal: options.signal ? AbortSignal.any([options.signal, halt]) : halt,
          ...(affordable !== undefined && affordable < (options.maxTokens ?? model.maxTokens) ? { maxTokens: affordable } : {}),
          ...(FETCH_APIS.includes(model.api) ? { fetch: callFetch(sink, { ...(options.fetch ? { base: options.fetch } : {}) }) } : {}),
        }), estimate, stop => { refusal = onRefused?.(stop); }, gateway, options.supersede);
      for await (const event of source) {
        if (event.type === 'done' || event.type === 'error') await refusal;
        output.push(event);
      }
    })().catch(error => {
      output.push({ type: 'error', reason: 'error', error: { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: 'error', errorMessage: error instanceof Error ? error.message : 'Accounting failed',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    }).finally(() => output.end());
    return output;
  }) as P['stream'];
  return { ...provider, stream: wrap(provider.stream), streamSimple: wrap(provider.streamSimple) };
}
