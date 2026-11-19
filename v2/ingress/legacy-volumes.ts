// The volume origin also authenticates the existing caller or signed file URL.
const ORIGIN_HEADER = "x-camelrun-volume-origin";
const VOLUME_ROUTE = /^\/v1\/(?:volumes|links)(?:\/|$)/;

export interface LegacyVolumeOrigin {
  LEGACY_VOLUMES?: { fetch(request: Request, init?: RequestInit): Promise<Response> };
  LEGACY_VOLUMES_ORIGIN_TOKEN?: string;
}

export function legacyVolumes(request: Request, env: LegacyVolumeOrigin): Promise<Response> | undefined {
  const asked = new URL(request.url);
  if (!VOLUME_ROUTE.test(asked.pathname) || !env.LEGACY_VOLUMES) return undefined;
  if (!env.LEGACY_VOLUMES_ORIGIN_TOKEN) {
    return Promise.resolve(volumeError(503, "VOLUME_ORIGIN_MISCONFIGURED", "Volume origin is misconfigured"));
  }
  // The VPC service chooses the private address and port. Its URL provides the original Host.
  asked.protocol = "http:";
  const upstream = new Request(asked, request);
  upstream.headers.delete("host");
  upstream.headers.delete("x-agent-runtime-hop");
  upstream.headers.delete("x-agent-runtime-internal");
  upstream.headers.delete("x-agent-runtime-forwarded");
  upstream.headers.set(ORIGIN_HEADER, env.LEGACY_VOLUMES_ORIGIN_TOKEN);
  return env.LEGACY_VOLUMES.fetch(upstream, { redirect: "manual" }).catch(() => volumeError(502, "VOLUME_ORIGIN_UNAVAILABLE", "Volume origin is unavailable; retry"));
}

function volumeError(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
