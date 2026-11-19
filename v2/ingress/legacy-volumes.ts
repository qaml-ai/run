// The volume origin also authenticates the existing caller or signed file URL.
const ORIGIN_HEADER = "x-camelrun-volume-origin";
const VOLUME_ROUTE = /^\/v1\/(?:volumes|links)(?:\/|$)/;
const VOLUME_PATH = /^\/v1\/volumes\/(vol_[a-f0-9]{24})(?:\/|$)/;
const LINK_PATH = /^\/v1\/links\/([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\//;

export interface LegacyVolumeOrigin {
  LEGACY_VOLUMES?: { fetch(request: Request, init?: RequestInit): Promise<Response> };
  LEGACY_VOLUMES_ORIGIN_TOKEN?: string;
  LEGACY_VOLUMES_ROLLOUT?: string;
  LEGACY_VOLUMES_READ_ROLLOUT?: string;
}

function volumeInPath(path: string) {
  const volume = VOLUME_PATH.exec(path)?.[1];
  if (volume) return volume;
  const payload = LINK_PATH.exec(path)?.[1];
  if (!payload) return undefined;
  // The payload is only a routing hint. The origin checks the signature and tenant.
  try {
    const bytes = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
    const grant = JSON.parse(new TextDecoder().decode(bytes)) as { volume?: unknown } | null;
    return typeof grant?.volume === "string" && /^vol_[a-f0-9]{24}$/.test(grant.volume) ? grant.volume : undefined;
  } catch {
    return undefined;
  }
}

export function legacyVolumes(request: Request, env: LegacyVolumeOrigin): Promise<Response> | undefined {
  const asked = new URL(request.url);
  if (!env.LEGACY_VOLUMES || !VOLUME_ROUTE.test(asked.pathname)) return undefined;
  const volume = volumeInPath(asked.pathname);
  const selected = (rollout?: string) => rollout === "all" ||
    !!volume && !!rollout?.split(",").some(id => id.trim() === volume);
  if (!selected(env.LEGACY_VOLUMES_ROLLOUT) &&
      !(request.method === "GET" && selected(env.LEGACY_VOLUMES_READ_ROLLOUT))) return undefined;
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
