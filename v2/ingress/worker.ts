import { WorkerEntrypoint } from "cloudflare:workers";
import ingress, { fetchLegacyApi } from "./index.ts";

export class LegacyOrigin extends WorkerEntrypoint {
  fetch(request: Request): Promise<Response> {
    return fetchLegacyApi(request);
  }
}

export default ingress;
