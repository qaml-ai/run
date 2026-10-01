/** Adding Camel to Discord before sign-in: resume it afterwards. The server checks the path again. */
export function discordInstallNext(pathname: string, search: string): string | undefined {
  if (pathname !== "/console/channels") return;
  const query = new URLSearchParams(search);
  if (!query.has("discord_install")) return;
  const guild = query.get("guild_id");
  return `/console/discord/install${guild && /^\d{1,20}$/.test(guild) ? `?guild_id=${guild}` : ""}`;
}

export function consoleLoginUrl(provider: "google" | "github", next?: string): string {
  return `/console/auth/${provider}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}
