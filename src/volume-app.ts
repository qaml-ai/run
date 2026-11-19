import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Principal, Accounts } from "./accounts.ts";
import { json } from "./api-helpers.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { errorCode, errorFields, errorHeaders, errorStatus, HttpError, signInHint } from "./http.ts";
import { expireIdempotencyKeys, idempotency } from "./idempotency.ts";
import type { FileLinks } from "./files.ts";
import { internalRequests } from "./internal-requests.ts";
import { safeError } from "./metrics.ts";
import type { Ownership } from "./ownership.ts";
import { errorText } from "./protocol.ts";
import { volumeLinkRoutes, volumeRoutes } from "./volume-api.ts";
import { VolumeService, type VolumeOptions } from "./volumes.ts";

export const VOLUME_ORIGIN_HEADER = "x-camelrun-volume-origin";
type Env = { Variables: { principal: Principal } };
const sha256 = (text: string) => createHash("sha256").update(text).digest();

export function volumeApp(options: {
  accounts: Pick<Accounts, "authenticate" | "db">;
  consoleAuth: Pick<ConsoleAuth, "principal" | "allowsMutation">;
  volumes: VolumeService;
  links: FileLinks;
  sessionSecret: string;
  originToken: string;
}) {
  const { accounts, consoleAuth, volumes, links } = options;
  const app = new Hono<Env>();
  const internal = internalRequests(options.sessionSecret);
  const token = sha256(options.originToken);
  const origin = signInHint(links.publicUrl);
  const route = (config: { method: string; path: string }, handler: (c: Context<Env>) => Response | Promise<Response>, path = config.path.replaceAll(/{(\w+)}/g, ":$1")) =>
    app.on(config.method.toUpperCase(), path, handler);

  app.get("/healthz", c => c.json({ ok: true }));
  internal.mountVolumeOperations(app, volumes);
  app.use("/v1/*", async (c, next) => {
    if (!timingSafeEqual(token, sha256(c.req.header(VOLUME_ORIGIN_HEADER) ?? ""))) {
      const [timestamp, signature] = (c.req.header("x-agent-runtime-hop") ?? "").split(".");
      const url = new URL(c.req.url);
      const expected = internal.signature(timestamp, `hop:${url.pathname}${url.search}`, "");
      if (!(Math.abs(Date.now() - Number(timestamp)) <= 60_000) || !signature || !timingSafeEqual(sha256(signature), sha256(expected))) {
        throw new HttpError(401, "Volume origin authorization required");
      }
    }
    await next();
  });
  volumeLinkRoutes(route, () => volumes, () => links, () => accounts.db);
  app.use("/v1/*", async (c, next) => {
    const authorization = c.req.header("authorization");
    const principal = authorization ? await accounts.authenticate(authorization) : await consoleAuth.principal(c.req.raw);
    if (!principal) throw new HttpError(401, authorization ? `Invalid, expired or revoked token. ${origin}` : `No credentials. Sign in to the console, or: ${origin}`);
    if (!authorization && !["GET", "HEAD"].includes(c.req.method) && !consoleAuth.allowsMutation(c.req.raw)) {
      throw new HttpError(403, "Console requests must be same-origin");
    }
    c.set("principal", principal);
    await next();
  });
  app.use("/v1/*", idempotency({
    db: () => accounts.db, tenant: c => c.var.principal.tenant, skip: () => false,
    secret: path => /^\/v1\/volumes\/[^/]+\/links$/.test(path),
  }));
  volumeRoutes(route, () => volumes, () => links);
  app.all("/v1/*", () => { throw new HttpError(404, "Unknown API route"); });
  app.onError((error, c) => {
    const status = errorStatus(error, 400);
    for (const [name, value] of Object.entries(errorHeaders(error))) c.header(name, value);
    return json(c, status, { error: errorText(error), code: errorCode(error, status), ...errorFields(error) });
  });
  return app;
}

export function clusterVolumes(options: VolumeOptions & { ownership: Ownership; sessionSecret: string }) {
  const { ownership, sessionSecret, ...volumes } = options;
  const { signedPost, volumePeer } = internalRequests(sessionSecret);
  return new VolumeService({
    ...volumes, ownership,
    peer: volumePeer,
    deliver: async (agent, tenant, request) => {
      const owner = await ownership.route(agent) ?? await ownership.peer();
      if (!owner) return; // No legacy agent runtime is serving watchers.
      const response = await signedPost(owner, `/internal/agents/${agent}/requests`, { tenant, request });
      if (!response.ok) {
        ownership.forget(agent);
        throw new HttpError(response.status, `Agent owner answered HTTP ${response.status}`);
      }
    },
  });
}

export function sweepVolumeReceipts(db: VolumeOptions["db"]) {
  return setInterval(() => void expireIdempotencyKeys(db).catch(error =>
    console.error(JSON.stringify({ type: "idempotency_expiry_failed", error: safeError(error) }))), 60 * 60_000).unref();
}
