import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { getModels, getModel, callSettings, withOpenRouterHosts, reasoningFloor } from "./model-catalog.ts";
import { resolveModel, routeModel, type ModelEndpoints, type CustomProviders } from "./model-policy.ts";
import { deepseekContext, refusedReasoningReplay } from "./deepseek-policy.ts";
import { OutputRequest } from "./output-request.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { boundedModel } from "./model-context.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import { modelOutbound } from "./security-outbound.ts";
import { gatewayUrl } from "./model-gateway.ts";
import { FETCH_APIS } from "./model-call-fetch.ts";
import { streamTimeouts, watchedStream, isStalled, type Stall } from "./model-stream.ts";
import { runtimeStreamTimeouts, type ModelTimeoutEnv } from "./model-runtime-options.ts";
import { PREPARED_MODEL_CREDENTIALS } from "./model-request-auth.ts";
import { modelCallKind } from "./model-call-context.ts";
import { contentFilterFallbacks } from "./default-model-policy.ts";
import { isContentFilterBlock, isModelUnavailable } from "./model-errors.ts";
import { ModelReplayRetry, type ModelRetryEvent } from "./model-replay-retry.ts";
import { missingModelKey } from "./selfhost-policy.ts";
import { FlexWait, asksFlex, flexFallbackDeltaUsd, flexWaitMs } from "./model-flex-wait.ts";

/** `flexWaitSeconds`: how long a call asked on flex waits for flex capacity before the default tier takes it (model-flex-wait.ts). */
export type ModelRequestSettings = AgentConfiguration & { requestId?: string; outputReminded?: boolean; flexWaitSeconds?: number; output?: { schema?: Record<string, unknown>; [key: string]: unknown } };
export type ModelCredentials = { apiKey?: string; baseUrl?: string; headers?: Record<string, string>; region?: string; bearer?: true; identity?: true; deployments?: Record<string, string> };
export type ModelHooks = {
  agentId?: () => Promise<string>;
  beforeRequest?: () => Promise<void>;
  onStreamEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
  onDiscardedOutput?: (message: AssistantMessage) => void | Promise<void>;
  onRetryEvent?: (event: ModelRetryEvent) => void | Promise<void>;
  onStall?: (stall: Stall & { provider: string; model: string }) => void | Promise<void>;
  wrapProvider?: (provider: Provider) => Provider;
  settings?: () => Promise<ModelRequestSettings>;
  credentials?: (provider: string) => Promise<ModelCredentials | undefined>;
  endpoints?: ModelEndpoints;
  customProviders?: CustomProviders;
};

export function withSettings(provider: Provider, hooks: ModelHooks, env: ModelTimeoutEnv & { TEST_MODE?: string; TEST_MODEL?: string; TEST_MODEL_BASE_URL?: string; TEST_MODEL_API?: Api; AGENT_CONTENT_FILTER_FALLBACKS?: string; AGENT_TENANT?: string; AGENT_FLEX_WAIT_SECONDS?: string }): Provider {
  const timeouts = runtimeStreamTimeouts(env);
  /**
   * A virtual model's routing for the message being answered: the member that answered last (`previous`), the member
   * whose request just failed (`failed`), and every member's failure since the last answer (`failures`), for the log.
   */
  let routing: { user: string; previous?: Model<Api>; failed?: Model<Api>; failures: { member: string; error: string }[] } | undefined;
  const member = (model: Model<Api>) => `${model.provider}/${model.id}${(model as { serviceTier?: string }).serviceTier ? ` (${(model as { serviceTier?: string }).serviceTier})` : ""}`;
  const failed = (model: Model<Api>, message: AssistantMessage) => {
    routing?.failures.push({ member: member(model), error: (message.errorMessage ?? message.stopReason ?? "failed").slice(0, 300) });
  };
  const outputRequest = new OutputRequest();
  const replayRetry = new ModelReplayRetry(hooks.onRetryEvent);
  const filterFallbacks = contentFilterFallbacks(env.AGENT_CONTENT_FILTER_FALLBACKS);
  const prepare = async (model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => {
    const callKind = modelCallKind(context);
    await hooks.beforeRequest?.();
    const config = await hooks.settings?.() ?? {};
    if (config.model?.startsWith("camelrun/")) {
      const user = config.requestId ?? String([...context.messages].reverse().find(message => message.role === "user")?.timestamp ?? 0);
      if (!routing || routing.user !== user) routing = { user, failures: [] };
      let selected = routeModel(resolveModel(config.model), { reason: routing.failed ? "retry" : routing.previous ? "continuation" : "user", failed: routing.failed, previous: routing.previous });
      if (!selected) {
        // Every member failed this request, and the request is made again (Pi's retry, with its backoff and its bound):
        // it starts again at the head, as on the Node runtime, instead of failing with no member's error in view.
        console.log(JSON.stringify({ type: "virtual_model_chain_restart", tenant: env.AGENT_TENANT ?? null, model: config.model, failures: routing.failures.slice(-8) }));
        routing.failed = undefined;
        selected = routeModel(resolveModel(config.model), { reason: "user" })!;
      }
      model = { ...boundedModel(selected, config.runLimits?.contextTokens), ...(env.TEST_MODEL === "1" ? { baseUrl: model.baseUrl, api: model.api, runtimeApi: selected.api } : {}) };
    }
    const credential = await hooks.credentials?.(model.provider);
    if (hooks.credentials && !credential && config.keyScope)
      throw new Error(`No ${model.provider} API key is configured for key scope ${config.keyScope} or this tenant; set one with PUT /v1/key-scopes/${config.keyScope}/providers/${model.provider}`);
    if (credential?.baseUrl) {
      const catalog = getModel(model.provider, model.id);
      // A scope may point back to the scripted test provider, whose wire API
      // stays the fixture's API even when the logical model uses another one.
      const scripted = env.TEST_MODEL === "1" && credential.baseUrl === env.TEST_MODEL_BASE_URL;
      model = { ...model, api: scripted ? env.TEST_MODEL_API ?? "openai-completions"
        : (model as Model<Api> & { runtimeApi?: Api }).runtimeApi ?? catalog?.api ?? model.api };
      if (FETCH_APIS.includes(model.api) && catalog) model = { ...model, baseUrl: catalog.baseUrl };
    }
    let fallback = filterFallbacks.get(`${model.provider}/${model.id}`);
    if (fallback && (credential?.identity || credential?.baseUrl && !credential.deployments || !(await hooks.credentials?.(fallback.provider))?.apiKey)) fallback = undefined;
    const virtualNext = config.model?.startsWith("camelrun/") ? routeModel(resolveModel(config.model), { reason: "retry", failed: model }) : undefined;
    const structured = callKind === "compaction" ? { context, toolChoice: undefined } : outputRequest.prepare(model, context, config);
    const { toolChoice } = structured;
    context = structured.context;
    const deployment = credential?.deployments?.[model.id];
    if (model.provider === "azure" && !credential?.identity && (!credential?.baseUrl || !deployment))
      throw new Error(`No azure deployment is configured for ${model.provider}/${model.id} on this runtime; move the agent to a model you can use (GET /v1/models?available=true)`);
    if (!credential && !getModels(model.provider).length && !["test", "camel-test", "cloudflare"].includes(model.provider) && !hooks.endpoints?.[model.provider])
      throw new Error(`${model.provider} provider is gone; set it again with PUT /v1/providers/${model.provider}`);
    if (!credential && !["test", "camel-test", "cloudflare"].includes(model.provider))
      throw new Error(missingModelKey(model.provider, model.id, env));
    if (model.provider === "amazon-bedrock" && !credential?.apiKey && !options.apiKey)
      throw Object.assign(new Error("Bedrock requires an API key"), { code: "model_key_missing" });
    const onPayload = options.onPayload;
    const reasoning = (options as SimpleStreamOptions).reasoning || reasoningFloor(model);
    let transportError: string | undefined;
    const tenantFetch: typeof fetch | undefined = credential?.baseUrl ? async (input, init) => {
      try {
        const original = input instanceof Request ? input.url : String(input);
        const target = FETCH_APIS.includes(model.api) ? gatewayUrl(model, original, credential.baseUrl!) : original;
        const outbound = modelOutbound(env as unknown as Record<string, unknown>);
        await outbound.reachable(target);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!credential.apiKey) { headers.delete("authorization"); headers.delete("x-api-key"); }
        if (credential.deployments) { headers.delete("authorization"); headers.delete("x-api-key"); headers.set("api-key", credential.apiKey!); }
        if (credential.bearer && credential.apiKey) { headers.set("authorization", `Bearer ${credential.apiKey}`); headers.delete("x-api-key"); }
        const response = await (options.fetch ?? fetch)(target, { ...init, headers, redirect:"manual" });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("Custom provider redirects are not allowed"); }
        return response;
      } catch (error) { transportError = error instanceof Error ? error.message : String(error); throw error; }
    } : undefined;
    const prepared = {
      [PREPARED_MODEL_CREDENTIALS]: credential,
      modelCallKind: callKind,
      ...options,
      ...(model.api === "openai-codex-responses" ? { sessionId: await hooks.agentId?.() ?? options.sessionId } : {}), ...(toolChoice !== undefined ? { toolChoice: toolChoice as SimpleStreamOptions["toolChoice"] } : {}), ...callSettings(model, config, config.thinkingLevel),
      ...(reasoning ? { reasoning } : {}),
      ...(fallback || virtualNext ? { supersede: (message: AssistantMessage) => fallback && isContentFilterBlock(message) ? "content_filter" as const : virtualNext && !message.content.length && isModelUnavailable(message) ? "unavailable" as const : undefined } : {}),
      ...(credential ? { apiKey: credential.bearer ? "runtime-bearer" : credential.apiKey ?? "keyless" } : {}),
      ...(credential?.identity ? { endpointIdentity: true } : {}),
      ...(deployment ? { azureDeployment: deployment, env: { AZURE_OPENAI_BASE_URL: credential!.baseUrl!, AZURE_OPENAI_API_VERSION: "v1", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${model.id}=${deployment}` } } : {}),
      ...(tenantFetch ? { fetch:tenantFetch } : {}),
      ...(model.api === "bedrock-converse-stream" ? { bearerToken: credential?.apiKey ?? options.apiKey, region: credential?.region } : {}),
      headers: { ...credential?.headers, ...options.headers, ...config.modelHeaders, ...(credential?.identity ? { "X-Agent-Runtime-Identity": credential.apiKey } : {}), ...(credential?.bearer && credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}`, "x-api-key": null } : {}) },
      onPayload: async (payload: unknown, target: Model<Api>) => {
        const adjusted = withOpenRouterHosts(target, payload, config.dataCollection ?? undefined);
        return await onPayload?.(adjusted, target) ?? adjusted;
      },
    };
    return { model: credential?.baseUrl && !FETCH_APIS.includes(model.api) ? { ...model, baseUrl: credential.baseUrl } : model, context: normalizeContext(deepseekContext(model, context)), options: prepared, config, fallback, virtualNext, callKind, transportError: () => transportError };
  };
  const wrap = (simple: boolean) => (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        let prepared = await prepare(model, context, options);
        replayRetry.begin(prepared.config.requestId ?? String(context.messages.findLast(message => message.role === "user")?.timestamp ?? 0));
        // A call asked on flex that found no flex capacity: its wait (`flex`), and, once it moved to the default tier, from what.
        let flex: FlexWait | undefined, fellBack: { model: string; waitedMs: number; attempts: number } | undefined;
        let retry = false;
        do {
        retry = false;
        let stalled: Promise<void> | undefined;
        const stream = watchedStream(prepared.model, (signal, activity) => {
          const onProviderStreamEvent = prepared.options.onProviderStreamEvent;
          const options = { ...prepared.options, signal, onProviderStreamEvent: (event: unknown) => { activity(event); onProviderStreamEvent?.(event, prepared.model); } };
          return simple ? provider.streamSimple(prepared.model, prepared.context, options as SimpleStreamOptions) : provider.stream(prepared.model, prepared.context, options);
        }, streamTimeouts(prepared.model, prepared.config.thinkingLevel, prepared.config.runLimits, timeouts), options?.signal,
        stall => { stalled = Promise.resolve(hooks.onStall?.({ ...stall, provider: prepared.model.provider, model: prepared.model.id })); });
        for await (const event of stream) {
          if (event.type === "error" || event.type === "done") await stalled;
          if (event.type === "error" && event.reason !== "aborted" && !isStalled(event.error.errorMessage) && prepared.transportError()) event.error.errorMessage = prepared.transportError();
          // Pi retries transient provider errors. OpenRouter's DeepSeek replay
          // refusal is a 400, but the source runtime also retries this exact
          // request so OpenRouter can choose another host. Keep the prepared
          // context and payload unchanged, and never retry a tenant endpoint.
          if (event.type === "error" && event.reason !== "aborted" && prepared.model.provider === "openrouter" &&
              !prepared.options.endpointIdentity && refusedReasoningReplay(event.error.errorMessage) &&
              !options?.signal?.aborted && await replayRetry.retry(event.error, options?.signal)) {
            retry = true;
            continue;
          }
          // Flex with no capacity: asked again within the call's flex wait, then the next member (the default tier) takes it below.
          if (event.type === "error" && event.reason !== "aborted" && asksFlex(prepared.model) && !event.error.content.length && isModelUnavailable(event.error) && !options?.signal?.aborted) {
            flex ??= new FlexWait(flexWaitMs(env, prepared.config.flexWaitSeconds), hooks.onRetryEvent);
            if (await flex.retry(event.error, options?.signal)) { retry = true; continue; }
            if (prepared.virtualNext) {
              fellBack = { model: `${prepared.model.provider}/${prepared.model.id}`, waitedMs: flex.waitedMs(), attempts: flex.attempts };
              console.log(JSON.stringify({ type: "model_flex_fallback", tenant: env.AGENT_TENANT ?? null, agent: await hooks.agentId?.().catch(() => undefined) ?? null, model: fellBack.model,
                to: `${prepared.virtualNext.provider}/${prepared.virtualNext.id}`, toTier: (prepared.virtualNext as { serviceTier?: string }).serviceTier ?? null, waitedMs: fellBack.waitedMs, attempts: fellBack.attempts, error: event.error.errorMessage?.slice(0, 300) ?? null }));
            }
          }
          if (event.type === "done" && flex && asksFlex(prepared.model)) await flex.success();
          if (event.type === "done" && fellBack) {
            // What the move cost over flex, for the same tokens: the default tier's prices against flex's.
            console.log(JSON.stringify({ type: "model_flex_fallback_cost", tenant: env.AGENT_TENANT ?? null, model: fellBack.model, servedTier: (event.message.usage as { serviceTier?: string }).serviceTier ?? null,
              deltaUsd: flexFallbackDeltaUsd(prepared.model, event.message.usage) ?? null, waitedMs: fellBack.waitedMs, attempts: fellBack.attempts }));
          }
          if (event.type === "error" && event.reason !== "aborted" && prepared.virtualNext && !event.error.content.length && isModelUnavailable(event.error) && !options?.signal?.aborted) {
            routing!.failed = prepared.model;
            failed(prepared.model, event.error);
            prepared = await prepare(prepared.virtualNext, context, options);
            retry = true;
            continue;
          }
          if (event.type === "error" && event.reason !== "aborted" && prepared.fallback && isContentFilterBlock(event.error) && !options?.signal?.aborted) {
            try { prepared = await prepare(prepared.fallback, context, options); retry = true; continue; }
            catch { /* If the fallback is unavailable, retain the provider's original refusal. */ }
          }
          if (event.type === "error" && prepared.options.toolChoice !== undefined && /400/.test(event.error.errorMessage ?? "") && /tool.?choice|forced.*tool/i.test(event.error.errorMessage ?? "")) {
            outputRequest.refuse();
            delete prepared.options.toolChoice;
            retry = true;
            continue;
          }
          if (event.type === "done" && prepared.callKind === "response" && !options?.signal?.aborted && outputRequest.remind(event.message, prepared.config)) {
            await hooks.onDiscardedOutput?.(event.message);
            prepared = await prepare(prepared.model, context, options);
            retry = true;
            continue;
          }
          if (routing && event.type === "error") {
            routing.failed = prepared.model;
            if (event.reason !== "aborted") {
              failed(prepared.model, event.error);
              // The chain's last member failed too: what each member answered, so the failure can be read in the logs.
              if (!prepared.virtualNext) console.log(JSON.stringify({ type: "virtual_model_chain_failed", tenant: env.AGENT_TENANT ?? null, model: prepared.config.model, failures: routing.failures.slice(-8) }));
            }
          }
          if (routing && event.type === "done") { routing.previous = prepared.model; routing.failed = undefined; routing.failures = []; }
          // Cut off at its output limit (Responses' incomplete: max_output_tokens): a truncated answer, as from any model,
          // never a member failure (the next member has the same limit). Logged: a reasoning model can spend it all thinking.
          if (event.type === "done" && event.message.stopReason === "length")
            console.log(JSON.stringify({ type: "model_output_cut", tenant: env.AGENT_TENANT ?? null, model: `${prepared.model.provider}/${prepared.model.id}`, maxTokens: prepared.model.maxTokens,
              output: event.message.usage?.output ?? null, answered: event.message.content.some(part => part.type === "text" || part.type === "toolCall") }));
          if (event.type === "done") await replayRetry.success();
          await hooks.onStreamEvent?.(event);
          output.push(event);
        }
        const result = await stream.result();
        if (retry) await hooks.beforeRequest?.();
        else output.end(result);
        } while (retry);
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push({ type: "error", reason, error: message }); output.end(message);
      }
    })();
    return output;
  };
  return { ...provider, stream: wrap(false), streamSimple: wrap(true) };
}

