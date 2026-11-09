/** Server-only configuration. Cloudflare generation replaces this with runtime bindings. */
export async function env(): Promise<Record<string, string | undefined>> { return process.env; }
