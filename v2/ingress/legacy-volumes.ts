// The volume origin also authenticates the existing caller or signed file URL.
const ORIGIN_HEADER = "x-camelrun-volume-origin";
const VOLUME_ROUTE = /^\/v1\/(?:volumes|links)(?:\/|$)/;

export interface LegacyVolumeOrigin {
  LEGACY_VOLUMES_ORIGIN?: string;
  LEGACY_VOLUMES_ORIGIN_TOKEN?: string;
}

export function legacyVolumes(request: Request, env: LegacyVolumeOrigin, send = fetch): Promise<Response> | undefined {
  const asked = new URL(request.url);
  if (!VOLUME_ROUTE.test(asked.pathname) || !env.LEGACY_VOLUMES_ORIGIN) return undefined;
  const origin = URL.parse(env.LEGACY_VOLUMES_ORIGIN);
  if (!env.LEGACY_VOLUMES_ORIGIN_TOKEN || !origin || !["http:", "https:"].includes(origin.protocol) || origin.origin !== env.LEGACY_VOLUMES_ORIGIN) {
    return Promise.resolve(volumeError(503, "VOLUME_ORIGIN_MISCONFIGURED", "Volume origin is misconfigured"));
  }
  origin.pathname = asked.pathname;
  origin.search = asked.search;
  const upstream = new Request(origin, request);
  upstream.headers.delete("host");
  upstream.headers.delete("x-agent-runtime-hop");
  upstream.headers.delete("x-agent-runtime-internal");
  upstream.headers.delete("x-agent-runtime-forwarded");
  upstream.headers.set(ORIGIN_HEADER, env.LEGACY_VOLUMES_ORIGIN_TOKEN);
  return send(upstream, { redirect: "manual" }).catch(() => volumeError(502, "VOLUME_ORIGIN_UNAVAILABLE", "Volume origin is unavailable; retry"));
}

function volumeError(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
