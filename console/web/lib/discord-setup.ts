import type { SignupSource } from "./signup-source";

/** Adding Camel to Discord before sign-in: resume it afterwards. The server checks the path again. */
export function discordInstallNext(pathname: string, search: string): string | undefined {
  if (pathname !== "/console/channels") return;
  const query = new URLSearchParams(search);
  if (!query.has("discord_install")) return;
  const guild = query.get("guild_id");
  return `/console/discord/install${guild && /^\d{1,20}$/.test(guild) ? `?guild_id=${guild}` : ""}`;
}

/** GitHub's or Google's sign-in, coming back to `next`, carrying where the browser came from for a new account (lib/signup-source.ts). */
export function consoleLoginUrl(provider: "google" | "github", next?: string, source: SignupSource = {}): string {
  const query = Object.entries({ next, ...source }).filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join("&");
  return `/console/auth/${provider}${query ? `?${query}` : ""}`;
}
