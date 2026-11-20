import { WorkerEntrypoint } from "cloudflare:workers";
import ingress, { fetchLegacyApi, type LegacyOriginEnv } from "./index.ts";

export class LegacyOrigin extends WorkerEntrypoint<LegacyOriginEnv> {
  fetch(request: Request): Promise<Response> {
    return fetchLegacyApi(request, this.env);
  }
}

export default ingress;
