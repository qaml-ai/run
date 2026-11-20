import { legacyBrowserTokenAgent } from "../../../shared/legacy-browser-tokens.ts";
import { unsupportedV1Operation, type V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import { readText } from "./account-http.ts";
import { apiRequest } from "./admission.ts";
import { BrowserTokens } from "./browser-tokens.ts";
import { HttpError } from "./errors.ts";
import { authenticateMoney, type MoneyEnv } from "./money-api.ts";
import { database } from "./postgres.ts";
import { browserUrl } from "./selfhost-policy.ts";

/** Same source ownership and token policy, without loading a native agent or writing a receipt. */
export async function legacyBrowserTokens(
  request: Request, env: MoneyEnv, compatibility?: Pick<V1Compatibility, "route">,
): Promise<Response | null> {
  const agent = legacyBrowserTokenAgent(request);
  // Without placement authority the original runtime must retain this request,
  // including its 501 for migrated agents. Do not admit or consume it here.
  if (!agent || !compatibility) return null;
  // An unknown bearer falls back before admission or body reads. Count handled
  // auth failures once, as the original API does, without counting a miss twice.
  const authentication = await (async () => {
    const authorization = request.headers.get("authorization")!;
    if (BrowserTokens.carries(authorization)) {
      new BrowserTokens(env.AGENT_SESSION_SECRET ?? env.API_TOKEN).verify(authorization);
      throw new HttpError(403, "A browser token only reads an agent's events, state, history and inputs");
    }
    return authenticateMoney(request, env, { bearerOnly: true });
  })().then(principal => ({ principal }), error => ({ error }));
  if ("error" in authentication) {
    await apiRequest(request, env);
    throw authentication.error;
  }
  const principal = authentication.principal;
  if (!principal) return null;
  await apiRequest(request, env);
  const sql = database(env);
  const { rowCount } = await sql.query(`select 1 from agents where id = $1 and tenant = $2 and not revoked
    and (expires_at is null or expires_at > $3) and header->'run' is null`, [agent, principal.tenantId, Date.now()]);
  if (!rowCount) throw new HttpError(404, "Unknown agent");
  if (await compatibility.route(principal.tenantId, agent)) throw unsupportedV1Operation();
  const secret = env.AGENT_SESSION_SECRET;
  if (!secret) throw new HttpError(503, "Browser tokens are unavailable");
  const text = await readText(request.body, 16 * 1024);
  let input: unknown;
  try { input = text ? JSON.parse(text) : {}; }
  catch { throw new HttpError(400, "Invalid JSON"); }
  const url = browserUrl(env, new URL(request.url).origin);
  return Response.json({ ...new BrowserTokens(secret).mint(principal.tenantId, agent, input), agentId: agent,
    ...(url ? { url } : {}) }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
