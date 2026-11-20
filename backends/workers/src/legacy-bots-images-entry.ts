import { WorkerEntrypoint } from "cloudflare:workers";
import { admissionError, apiRequest } from "./admission.ts";
import { HttpError, errorCode, errorFields, errorHeaders, errorStatus } from "./errors.ts";
import { legacyBotsImageAuthorization, legacyBotsImageGeneration } from "./legacy-bots-image-request.ts";
import { handleMediaRequest, type MediaBindings } from "./media-api.ts";
import { mediaAzure } from "./media-azure.ts";
import { keyServices } from "./security-services.ts";

type Env = MediaBindings & { LEGACY_BOTS_IMAGES_AUTH_SHA256?: string };
const tenant = "camel-bots";

/** The named binding keeps the original tenant, provider, and debit authorities. */
export class LegacyCamelBotsImages extends WorkerEntrypoint<Env> {
  async route(request: Request): Promise<Response | null> {
    const env = this.env;
    const authorization = legacyBotsImageAuthorization(request, env.LEGACY_BOTS_IMAGES_AUTH_SHA256);
    if (!authorization || !await legacyBotsImageGeneration(request)) {
      // Ingress retains its original request while this private copy is released.
      void request.body?.cancel().catch(() => {});
      return null;
    }

    // No response from this point may send the caller to a different origin.
    try {
      const { accounts } = await keyServices(env);
      const principal = await accounts.authenticate(authorization);
      if (principal?.tenant !== tenant || (principal.via !== "operator" && principal.via !== "token"))
        throw new HttpError(401, "Invalid, expired or revoked token", "UNAUTHORIZED");
      if (!mediaAzure(env)?.imageDeployment)
        throw new HttpError(503, "Image generation is unavailable", "IMAGE_UNAVAILABLE");
      await apiRequest(request, env);
      return await handleMediaRequest(request, env, {
        tenantId: tenant, kind: principal.via === "operator" ? "operator" : "api", scopes: ["*"], principal,
      }) ?? Response.json({ error: "Image generation is unavailable", code: "IMAGE_UNAVAILABLE" },
        { status: 503, headers: { "cache-control": "no-store" } });
    } catch (error) {
      const limited = admissionError(error);
      if (limited) return limited;
      const status = errorStatus(error, 500);
      const code = errorCode(error, status);
      if (status >= 500) console.error(JSON.stringify({ type: "legacy_bots_image_failed", status, code }));
      return Response.json({ error: error instanceof HttpError ? error.message : "Backend operation failed",
        code, ...errorFields(error), ...(error instanceof HttpError ? error.details : {}) },
        { status, headers: { "cache-control": "no-store", ...errorHeaders(error) } });
    }
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
