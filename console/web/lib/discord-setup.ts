/** Carry only a server setup intent across Camel login; the backend verifies server ownership. */
export function discordSetupNext(pathname: string, search: string): string | undefined {
  if (pathname !== "/console/channels") return;
  const guild = new URLSearchParams(search).get("discord_setup");
  return guild && /^\d{17,20}$/.test(guild) ? `/console/channels?discord_setup=${guild}` : undefined;
}

export function consoleLoginUrl(provider: "google" | "github", next?: string): string {
  return `/console/auth/${provider}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}
