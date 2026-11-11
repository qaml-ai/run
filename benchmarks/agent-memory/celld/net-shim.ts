/** node:net for celld (benchmarks only): celld does not implement node:net; the backend imports only isIP from it. */
const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export function isIPv4(input: string) { return v4.test(input); }
export function isIPv6(input: string) {
  if (!input.includes(":") || /[^0-9a-fA-F:.%]/.test(input.split("%")[0] ?? "")) return false;
  try { return new URL(`http://[${input}]/`).hostname.length > 2; } catch { return false; }
}
export function isIP(input: string) { return isIPv4(input) ? 4 : isIPv6(input) ? 6 : 0; }
export default { isIP, isIPv4, isIPv6 };
