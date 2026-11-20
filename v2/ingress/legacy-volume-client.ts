export const LEGACY_VOLUME_CLIENT_ADDRESS = "x-camelrun-volume-client-address";
export const LEGACY_VOLUME_CLIENT_ZONE = "x-camelrun-volume-client-worker-zone";
export const LEGACY_VOLUME_INTERNAL_CLIENT = "legacy-mcp";
export const LEGACY_VOLUME_ADDRESS_LENGTH = 45;

/** Cloudflare sends the caller Worker's DNS zone for its shared Worker address. */
export function legacyVolumeWorkerZone(value?: string | null) {
  const zone = value?.trim().toLowerCase();
  if (!zone || zone.length > 253) return;
  return zone.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? zone : undefined;
}
