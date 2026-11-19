import { WorkerEntrypoint } from "cloudflare:workers";
import ingress, { fetchLegacyApi } from "./index.ts";
import type { LegacyVolumeOrigin } from "./legacy-volumes.ts";

export class LegacyOrigin extends WorkerEntrypoint<LegacyVolumeOrigin> {
  fetch(request: Request): Promise<Response> {
    return fetchLegacyApi(request, this.env);
  }
}

export default ingress;
