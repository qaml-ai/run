/**
 * Where a tenant's provider key comes from (Accounts.providerKey): `tenant`, a key the tenant stored; `admin`, a key the
 * operator set in the tenant's tenants-file entry (`apiKeys`); `platform`, the platform's own key (`platformKeys`).
 */
export type KeySource = "tenant" | "admin" | "platform";

/**
 * Whether a call on a key from `source` is the platform's to fund: charged to a prepaid tenant's credit, with the
 * platform funding multiplier, and counted as platform usage. Only the platform's own key is. An operator's key in the
 * tenant's entry is the tenant's key, like one it stored itself: its provider bills whoever owns it, never the credit.
 * Every model, auxiliary (decisions, transcription, images, speech, realtime) and search path decides with this.
 */
export function chargesPlatform(source: KeySource): boolean {
  return source === "platform";
}
