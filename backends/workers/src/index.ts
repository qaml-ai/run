import { withMoneyMetrics } from "./money-metrics.ts";
import { sweepComputers } from './computers/service.ts';
import { CamelAgent, json, type Env } from "./agent.ts";
import {
  Directory,
  authenticate,
  controlRoutes,
  maintenance,
  type DirectoryEntry,
  type DirectoryFailure,
} from "./control.ts";
import { ApiError, agentToken, configuration } from "./api-contract.ts";
import { authorized, agentId, BadRequest, body } from "./validation.ts";
import { HttpError, errorCode, errorStatus } from "./errors.ts";
import { handleAdminRequest } from "./admin-api.ts";
import { handleServiceRequest } from "./service-api.ts";
import { handleMediaRequest } from "./media-api.ts";
import { handleComputerRequest } from "./computers/api.ts";
import { websocketAuthorization, negotiateEvents } from "./live-transport.ts";
import { publishScheduleEmails, deliverScheduleEmail } from "./schedules.ts";
import { metric, failure } from "./observability.ts";
import { withSql } from "./postgres.ts";
import {
  consumeWebhooks,
  publishPending,
  type DeliveryMessage,
} from "./webhooks.ts";
import { handleFileRequest, handleSignedFileRequest } from "./files.ts";
import { publicMoneyRoutes, authenticateMoney, moneyRoutes, moneyMaintenance, sendMoneyWebhooks } from "./money-api.ts";
import { BrowserTokens, type BrowserClaims } from "./browser-tokens.ts";
import { apiRequest, admissionError, errorFields, errorHeaders } from "./admission.ts";
import { BROWSER_READS, corsPreflight, corsResponse } from "./cors.ts";
import { browserResponse } from "./browser-response.ts";
import { decisionService, type DecisionEnv } from "./decision-service.ts";
import { decisionRoute } from "./decision-runtime.ts";
import {
  definitionRoutes,
  provisionDefinition,
  visibleConfiguration,
  configurationPatch,
} from "./definitions.ts";
import { statelessRoutes, agentLifecycleRoutes } from "./agent-routes.ts";
import { modelCatalog } from "./model.ts";
import { providerRoutes } from "./provider-routes.ts";
import { TENANT_CONFIGURATION_KEYS } from "./access-policy.ts";
import {
  readAgentSpendLimit,
  setAgentSpendLimit,
  agentSpendView,
} from "./agent-spend.ts";
export { CamelAgent };
export { TenantAdmission } from "./tenant.ts";
export { Volume } from "./volume.ts";
export { ContainerComputer, SandboxComputer } from "./computers/objects.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

function result<T>(value: T | DirectoryFailure): T {
  if (
    value !== null &&
    typeof value === "object" &&
    "failed" in value &&
    value.failed === true
  ) {
    const failure = value as DirectoryFailure;
    throw new ApiError(failure.status, failure.error, failure.code);
  }
  return value as T;
}
function credentials(entry: DirectoryEntry, token: string) {
  return {
    id: entry.id,
    token,
    expiresAt: entry.expiresAt,
    configHash: entry.configHash,
  };
}
function summary(entry: DirectoryEntry) {
  return {
    ...visibleConfiguration(entry.config),
    ...("forkedFrom" in entry ? { forkedFrom: entry.forkedFrom } : {}),
    id: entry.id,
    key: entry.key,
    name: entry.config.name ?? "",
    type: entry.config.type ?? "agent",
    model: entry.config.model,
    connected: false,
    running: false,
    expiresAt: entry.expiresAt,
    configHash: entry.configHash,
    resume: null,
  };
}
async function forward(request: Request, env: Env, id: string, path: string) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.AGENTS.getByName(id).fetch(new Request(url, request));
}
function scopedConfiguration(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BadRequest("Expected configuration object");
  for (const key of [
    ...TENANT_CONFIGURATION_KEYS,
    "definition",
    "openApi",
    "subject",
    "context",
    "humanInput",
    "subagents",
    "workspaceId",
    "remount",
    "initialMessages",
    "importMessages",
  ])
    if (Object.hasOwn(input, key))
      throw new ApiError(
        403,
        `Only the tenant can change an agent's ${key}`,
        "FORBIDDEN",
      );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withMoneyMetrics(env, async () => corsResponse(request, await (async () => {
    try {
      request = websocketAuthorization(request);
      const preflight = corsPreflight(request);
      if (preflight) return preflight;
      const signed = await handleSignedFileRequest(request, env);
      if (signed) return signed;
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/healthz" && request.method === "GET")
        return json({
          ok: true,
          backend: "workers-native",
          experimental: true,
        });
      const publicMoney = await publicMoneyRoutes(request, env, ctx);
      if (publicMoney) return publicMoney;
      await apiRequest(request, env);
      const bearer = request.headers.get("authorization") ?? undefined;
      const browserTokens = new BrowserTokens(env.AGENT_SESSION_SECRET ?? env.API_TOKEN);
      let browser: BrowserClaims | undefined;
      if (BrowserTokens.carries(bearer)) {
        browser = browserTokens.verify(bearer!);
        const scope = path.slice(path.lastIndexOf("/") + 1);
        if (request.method !== "GET" || !BROWSER_READS.test(path) || !browser.scopes.includes(scope as never) || request.headers.get("upgrade"))
          throw new ApiError(403, "This browser token does not grant this read", "FORBIDDEN");
      }
      let auth = browser ? null : await authenticateMoney(request, env)
        ?? (((env.TEST_MODE === "1" && !bearer?.startsWith("Bearer art_")) || await authorized(request, env.API_TOKEN)) ? await authenticate(request, env) : null);
      const service = await handleServiceRequest(request, env, auth);
      if (service) return service;
      const match =
        /^\/(clients|v1\/agents|experimental\/agents)\/([^/]+)(\/.*)?$/.exec(
          path,
        );
      let entry: DirectoryEntry | null = null;
      if (match) {
        const idOrKey = agentId(decodeURIComponent(match[2]));
        if (auth) entry = await new Directory(env, auth.tenantId).get(idOrKey);
        else if (browser && browser.agent === idOrKey)
          entry = await new Directory(env, browser.tenant).get(idOrKey);
        else if (
          /^client_[a-f0-9]{40}$/.test(idOrKey) &&
          (await authorized(request, await agentToken(env.API_TOKEN, idOrKey)))
        ) {
          entry =
            (
              await withSql(
                env,
                async (sql) =>
                  (
                    await sql.query(
                      "SELECT header,revoked FROM agents WHERE id=$1",
                      [idOrKey],
                    )
                  ).rows,
              )
            ).map((row) => ({
              ...row.header,
              ...(row.revoked ? { deleted: true } : {}),
            }))[0] ?? null;
        }
      }
      if (!auth && !entry)
        throw new ApiError(401, "Unauthorized", "UNAUTHORIZED");
      if (auth) {
        const computers = await handleComputerRequest(request, env, auth);
        if (computers) return computers;
      }
      if (!match) {
        if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
        if (
          env.RATE_LIMITER &&
          !(await env.RATE_LIMITER.limit({ key: auth.tenantId })).success
        )
          throw new ApiError(429, "Rate limit exceeded", "RATE_LIMITED");
        if (
          path === "/__test/flush-webhooks" &&
          env.TEST_MODE === "1" &&
          auth.kind === "operator" &&
          request.method === "POST"
        )
          return json({ queued: await publishPending(env) });
        const money = await moneyRoutes(request, env, auth, ctx);
        if (money) return money;
        if (path === "/v1/decisions") {
          const decisions = decisionService(
            env as Env & DecisionEnv,
            async () => ({ tenant: auth!.tenantId }),
          );
          const response = await decisionRoute(request, decisions);
          if (response) return response;
        }
        const control = await controlRoutes(request, env, auth);
        if (control) return control;
        const media = await handleMediaRequest(request, env, auth);
        if (media) return media;
        const files = await handleFileRequest(request, env, auth);
        if (files) return files;
        const definition = await definitionRoutes(request, env, auth);
        if (definition) return definition;
        const provider = await providerRoutes(request, env, auth);
        if (provider) return provider;
        const run = await statelessRoutes(request, env, auth);
        if (run) return run;
        if (path === "/v1/models" && request.method === "GET")
          return json(
            modelCatalog(env, url.searchParams.get("provider") ?? undefined),
          );
        if (path === "/v1/agents") {
          const directory = new Directory(env, auth.tenantId);
          if (request.method === "GET")
            return json(
              (await directory.list())
                .filter((entry) => entry.config.type !== "run")
                .map(summary),
            );
          if (request.method === "POST") {
            const raw = await body(request, 17 * 1024 * 1024);
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw new BadRequest("Expected configuration object");
            const input = await provisionDefinition(
              env,
              auth.tenantId,
              raw as Record<string, unknown>,
            );
            configuration(input, env.MODEL);
            const key = request.headers.get("Idempotency-Key") ?? undefined;
            const created = result(await directory.upsert(input, key, url.origin));
            if (Object.hasOwn(raw, "spendLimit"))
              await setAgentSpendLimit(
                env, auth.tenantId, created.id, (raw as { spendLimit: unknown }).spendLimit,
              );
            return json(
              credentials(created, await agentToken(env.API_TOKEN, created.id)),
              201,
            );
          }
        }
        throw new ApiError(404, "Unknown API route", "NOT_FOUND");
      }
      if (!entry) throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
      const tail = match[3] || "/";
      // Internal computer operations are reachable only through the service
      // binding. Public cleanup must use the account-scoped confirmation route.
      if (tail === "/__computer" && env.TEST_MODE !== "1")
        throw new ApiError(404, "Not found", "NOT_FOUND");
      const directory = new Directory(env, entry.tenantId);
      if (entry.deleted) {
        if (["/", "/credentials"].includes(tail) && request.method === "GET")
          throw new ApiError(404, "Unknown agent", "AGENT_NOT_FOUND");
        if (auth && tail === "/" && request.method === "DELETE") {
          result(await directory.remove(entry.id));
          return json({ deleted: true });
        }
        throw new ApiError(410, "Agent is deleted", "AGENT_GONE");
      }
      if (entry.expiresAt && entry.expiresAt <= Date.now())
        throw new ApiError(410, "Agent expired", "AGENT_EXPIRED");
      if (!entry.initialized)
        throw new ApiError(
          503,
          "Agent initialization is pending; retry creation",
          "INITIALIZATION_PENDING",
        );
      if (tail === "/browser-tokens" && request.method === "POST") {
        if (!auth || auth.kind === "oauth") throw new ApiError(403, "Account key required", "FORBIDDEN");
        return json({ ...browserTokens.mint(entry.tenantId, entry.id, await body(request, 16 * 1024)), agentId: entry.id }, 201);
      }
      if (tail === "/credentials" && request.method === "GET") {
        if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
        return json(
          credentials(entry, await agentToken(env.API_TOKEN, entry.id)),
        );
      }
      if (tail === "/" && request.method === "DELETE") {
        result(await directory.remove(entry.id));
        return json({ deleted: true });
      }
      if (tail === "/" && request.method === "GET") {
        const response = await forward(
          new Request(request.url, { headers: request.headers }),
          env,
          entry.id,
          "/tool-sources",
        );
        if (!response.ok) return response;
        return json({
          ...summary(entry),
          spendLimit: agentSpendView(
            await readAgentSpendLimit(env, entry.tenantId, entry.id),
          ),
          toolSources: await response.json(),
        });
      }
      if (tail === "/" && request.method === "PATCH") {
        if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
        const input = await body(request);
        if (
          !input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["name", "type"].includes(key))
        )
          throw new BadRequest("Only name and type may be patched here");
        return json(summary(result(await directory.upsert(
          { ...entry.config, ...input }, entry.key ?? entry.id, url.origin,
        ))));
      }
      if (tail === "/metadata" && request.method === "POST") {
        const input = await body(request, 4096);
        if (
          !input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["name", "type"].includes(key))
        )
          throw new BadRequest("Expected name and type");
        const next = result(await directory.upsert(
          { ...entry.config, ...input }, entry.key ?? entry.id, url.origin,
        ));
        return json({ name: next.config.name ?? "", type: next.config.type ?? "agent" });
      }
      if (tail === "/configuration") {
        if (request.method === "GET") return json(visibleConfiguration(entry.config));
        if (!["PUT", "PATCH"].includes(request.method))
          throw new ApiError(405, "Method not allowed");
        const next = await body(request);
        if (!next || typeof next !== "object" || Array.isArray(next))
          throw new BadRequest("Expected configuration object");
        if (!auth) scopedConfiguration(next);
        const updated = result(
          await directory.upsert(
            await configurationPatch(env, entry.tenantId, entry.config, next),
            entry.key ?? entry.id,
            url.origin,
          ),
        );
        if (Object.hasOwn(next, "spendLimit"))
          await setAgentSpendLimit(
            env, entry.tenantId, entry.id, (next as { spendLimit: unknown }).spendLimit,
          );
        return json({ id: updated.id, configHash: updated.configHash }, 202);
      }
      if (tail === "/mounts") {
        if (request.method === "GET")
          return json(entry.config.mounts ?? []);
        if (request.method === "PUT") {
          if (!auth) throw new ApiError(403, "Account key required", "FORBIDDEN");
          const input = (await body(request)) as { mounts?: unknown[] };
          const updated = result(
            await directory.upsert(
              { ...entry.config, mounts: input.mounts, remount: true },
              entry.key ?? entry.id,
            ),
          );
          return json(updated.config.mounts);
        }
      }
      if (
        match[1] === "experimental/agents" &&
        tail.startsWith("/__test/") &&
        env.TEST_MODEL !== "1"
      )
        throw new ApiError(404, "Not found");
      const lifecycle = !browser
        ? await agentLifecycleRoutes(request, env, entry, tail)
        : undefined;
      if (lifecycle) return lifecycle;
      if (!auth && tail === "/requests" && request.method === "POST") {
        const input = (await request.clone().json()) as { method?: string; params?: unknown };
        if (input.method === "configure") scopedConfiguration(input.params);
      }
      const response = await forward(request, env, entry.id, tail);
      return browser ? browserResponse(response, browser, tail) : response;
    } catch (error) {
      const limited = admissionError(error);
      if (limited) return limited;
      if (error instanceof ApiError || error instanceof HttpError)
        return Response.json({ error: error.message, code: error.code, ...errorFields(error), ...("details" in error ? error.details : {}) }, { status: error.status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
      if (error instanceof BadRequest || error instanceof URIError)
        return json({ error: error.message, code: "INVALID_REQUEST" }, 400);
      failure(env, "http_failed", error);
      const status = errorStatus(error, 500);
      return Response.json({ error: "Backend operation failed", code: errorCode(error, status) },
        { status, headers: { 'cache-control': 'no-store', ...errorHeaders(error) } });
    }
    })()));
  },
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env) {
    return withMoneyMetrics(env, async () => {
    await sendMoneyWebhooks(env);
    for (const message of batch.messages.filter(message => message.body.kind === "schedule")) {
      try { if (await deliverScheduleEmail(env, message.body.id)) message.ack(); else message.retry({ delaySeconds: 10 }); }
      catch { message.retry({ delaySeconds: 30 }); }
    }
    await consumeWebhooks({ ...batch, messages: batch.messages.filter(message => message.body.kind === "email") } as MessageBatch<DeliveryMessage>, env);
    for (const message of batch.messages) if (message.body.kind !== "email" && message.body.kind !== "schedule") message.ack();
    });
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    return withMoneyMetrics(env, async () => {
    try {
      await maintenance(env);
      await moneyMaintenance(env);
      await publishScheduleEmails(env);
      await sweepComputers(env);
      metric(env, "maintenance", { MaintenanceRuns: 1 });
    } catch (error) { failure(env, "maintenance_failed", error); throw error; }
    });
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;
