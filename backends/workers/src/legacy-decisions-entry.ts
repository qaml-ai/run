import { createHash, timingSafeEqual } from "node:crypto";
import { WorkerEntrypoint } from "cloudflare:workers";
import { accountServices } from "./account-services.ts";
import { readText } from "./account-http.ts";
import { admissionError, apiRequest, type AdmissionEnv } from "./admission.ts";
import { BrowserTokens } from "./browser-tokens.ts";
import { Decider, decisionRequest, decisionsAnswer } from "./decision-policy.ts";
import { decisionProvider } from "./decision-transport.ts";
import { DEFAULT_BUCKET, EndUserCredits, bucketInput, creditError, utcDay } from "./end-user-credits.ts";
import { HttpError, errorCode, errorFields, errorHeaders, errorStatus } from "./errors.ts";
import { transaction } from "./postgres.ts";
import { authenticationHint } from "./public-http.ts";
import { actorInput, identityInput } from "./security-policy.ts";
import { keyServices } from "./security-services.ts";
import { DECISION_LIMITS } from "../../../src/limits.ts";
import { chargesPlatform } from "../../../src/core/key-source.ts";

type Env = AdmissionEnv & { AGENT_DECISION_NODE_CONCURRENCY?: string; AGENT_DECISIONS_URL?: string; TEST_MODEL?: string; LEGACY_DECISIONS_BOTS_AUTH_SHA256?: string };
const deciders = new WeakMap<Env, Decider>();
function deciderFor(env: Env, creditMultiplier: number) {
  let decider = deciders.get(env);
  if (decider) return decider;
  const nodeConcurrent = Number(env.AGENT_DECISION_NODE_CONCURRENCY ?? DECISION_LIMITS.nodeConcurrent);
  if (!Number.isSafeInteger(nodeConcurrent) || nodeConcurrent < 1) throw new Error("AGENT_DECISION_NODE_CONCURRENCY must be a positive integer");
  decider = new Decider({
    provider: decisionProvider({ testUrl: env.AGENT_DECISIONS_URL, testMode: env.TEST_MODEL === "1" && env.TEST_MODE === "1" }),
    async key(tenant, scope, provider) {
      const { accounts, keyScopes } = await keyServices(env);
      const scoped = scope && await keyScopes.entry(tenant, scope, provider);
      if (scoped && scoped.apiKey) return { apiKey: scoped.apiKey, platform: false };
      const key = await accounts.providerKey(tenant, provider);
      if (!key?.key) return undefined;
      const platform = chargesPlatform(key.source);
      if (platform) {
        const limited = await accounts.billing.creditLimit(tenant);
        if (limited) throw limited;
      }
      return { apiKey: key.key, platform };
    },
    async tenantConcurrency(tenant) {
      const { accounts } = await keyServices(env);
      const limit = await accounts.billing.decisionConcurrency(tenant);
      return limit.source === "default" ? undefined : limit.limit;
    },
    creditMultiplier: () => creditMultiplier,
    limits: { nodeConcurrent },
  });
  deciders.set(env, decider);
  return decider;
}

const json = (body: unknown, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function discardUnreadBody(request: Request) {
  const body = request.body;
  // An early response otherwise leaves a transferred RPC request stream open.
  if (body && !body.locked) await body.cancel().catch(() => {});
}

/** Standalone v1 decisions keep the original accounts, OpenRouter keys and wallet ledgers. */
export class LegacyDecisions extends WorkerEntrypoint<Env> {
  protected readonly requiredTokenTenant?: string;

  async route(request: Request): Promise<Response | null> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/decisions") return null;
    try {
      return await this.#decide(request);
    } catch (error) {
      await discardUnreadBody(request);
      const limited = admissionError(error);
      if (limited) return limited;
      const status = errorStatus(error, 500);
      const code = errorCode(error, status);
      if (status >= 500) console.error(JSON.stringify({ type: "legacy_decision_failed", status, code }));
      return json({ error: error instanceof HttpError ? error.message : "Backend operation failed", code, ...errorFields(error) }, status, errorHeaders(error));
    }
  }

  async #decide(request: Request): Promise<Response> {
    const env = this.env;
    await apiRequest(request, env);
    const authorization = request.headers.get("authorization");
    if (BrowserTokens.carries(authorization ?? undefined)) {
      new BrowserTokens(env.AGENT_SESSION_SECRET ?? env.API_TOKEN).verify(authorization!);
      throw new HttpError(403, "A browser token only reads an agent's events, state, history and inputs");
    }
    const { accounts } = await keyServices(env);
    const origin = env.AGENT_PUBLIC_URL ?? env.PUBLIC_URL ?? new URL(request.url).origin;
    const { auth, oauth, limits } = accountServices(env, accounts, origin);
    const principal = authorization ? await accounts.authenticate(authorization) ?? await oauth.authenticate(authorization) : await auth.principal(request);
    if (!principal || (this.requiredTokenTenant && (principal.via !== "token" || principal.tenant !== this.requiredTokenTenant)))
      throw new HttpError(401, authenticationHint(request, origin));
    if (principal.via === "oauth")
      throw new HttpError(403, "An OAuth access token works with agents only: it cannot get agent tokens or make API tokens, links, webhooks, channels or provider keys. Use an API token or the console");
    if (principal.via === "console" && !auth.allowsMutation(request)) throw new HttpError(403, "Console requests must be same-origin");

    const tenant = principal.tenant;
    const decider = deciderFor(env, accounts.billing.pricing.openrouterCreditMultiplier);
    const saturated = decider.saturated(tenant);
    if (saturated) throw saturated;
    const text = await readText(request.body, DECISION_LIMITS.requestBytes);
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { throw new HttpError(400, "Invalid JSON"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Send a JSON object: {state, questions} or {items}");
    const { subject, context, actor: asked, bucket, keyScope, dataCollection, ...rest } = raw as Record<string, unknown>;
    if (dataCollection !== undefined && dataCollection !== null && dataCollection !== "deny") throw new HttpError(400, 'dataCollection is "deny" or null');
    const input = decisionRequest(rest);
    if (keyScope !== undefined && typeof keyScope !== "string") throw new HttpError(400, "keyScope is a key scope's name");
    if (bucket !== undefined && typeof bucket !== "string") throw new HttpError(400, "bucket is a bucket's name");
    const identity = identityInput({ subject, context });
    const actor = actorInput(asked);
    const endUser = identity?.subject;
    const namedBucket = endUser && bucket !== undefined ? bucketInput(bucket) : DEFAULT_BUCKET;
    const limited = await accounts.runLimit(tenant);
    if (limited) throw typeof limited === "string" ? new HttpError(402, limited, "SPEND_LIMIT") : limited;
    await limits.run(tenant);
    const credits = new EndUserCredits(accounts.db);
    const startedAt = Date.now();
    if (endUser) {
      const refused = await credits.refusal(tenant, endUser, namedBucket, { now: startedAt });
      if (refused) throw creditError(refused);
    }

    const decided = await decider.decide({ tenant, keyScope: keyScope || undefined, dataCollection }, input, request.signal);
    if (decided.usage) {
      const usage = { ...decided.usage, identity, actor, bucket, keyScope: keyScope || undefined };
      const receipt = `decision:${crypto.randomUUID()}`;
      await transaction(accounts.db, async sql => {
        if (endUser) await credits.debit(tenant, endUser, namedBucket, decided.chargedUsd, receipt,
          { call: "decision", usageDay: utcDay(startedAt) }, { sql });
        await accounts.recordUsageIn(sql, tenant, "", usage);
      });
    }
    return json(decisionsAnswer(decided, input.batch));
  }
}

/** Accept the Camel Bots app token on either legacy hostname, with billing decided by the original request. */
export class LegacyCamelBotsDecisions extends LegacyDecisions {
  protected override readonly requiredTokenTenant = "camel-bots";

  override async route(request: Request): Promise<Response | null> {
    const { protocol, hostname, pathname, port } = new URL(request.url);
    if (protocol !== "https:" || port || (hostname !== "run.camelai.com" && hostname !== "agents.camelai.dev") ||
        pathname !== "/v1/decisions" || request.method !== "POST" || request.headers.has("upgrade")) return null;
    const expected = this.env.LEGACY_DECISIONS_BOTS_AUTH_SHA256;
    const auth = request.headers.get("authorization");
    if (expected && /^[a-f0-9]{64}$/.test(expected) && auth) {
      const digest = createHash("sha256").update(auth).digest();
      if (timingSafeEqual(digest, Buffer.from(expected, "hex"))) return super.route(request);
    }
    await discardUnreadBody(request);
    return json({ error: "Decisions are unavailable", code: "UNAUTHORIZED" }, 401);
  }
}

// The deployment is private. Ingress reaches its single route over a service binding.
export default { fetch: () => new Response(null, { status: 404 }) };
