// Generated from src/tool-sources.ts by scripts/reuse-source-input.mjs.
export const sameOrigin = (audience: string, url: URL | string) => { try { return new URL(audience).origin === new URL(url).origin; } catch { return false; } };
/** A stable audience in the tenant's namespace: `urn:camelrun:<tenant>:` and a name of letters, digits and `._~:-`. */
export const tenantAudience = (audience: string, tenant: string) => audience.startsWith(`urn:camelrun:${tenant}:`) && /^[A-Za-z0-9._~:-]{1,200}$/.test(audience.slice(`urn:camelrun:${tenant}:`.length));
export const ownAudience = (audience: string, url: URL | string, tenant: string) => sameOrigin(audience, url) || tenantAudience(audience, tenant);
/** The audience to mint a source's tokens for: its own, if still one it may have (checked again: definitions saved before the rule), else its URL. */
export const audienceOf = (audience: string | undefined, url: string, tenant: string) => audience && ownAudience(audience, url, tenant) ? audience : url;

export const mcpToolName = (server: string, tool: string) => `${server}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 80);
