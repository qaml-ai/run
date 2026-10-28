/** Where a browser came from, as a sign-in started here tells the server: `ref` and `from` (src/signup-source.ts). */
export type SignupSource = { ref?: string; from?: string };

/**
 * Where this browser came from, for the account a sign-up here makes: the `ref` the link that opened the console
 * carries (`?ref=run-slack`), and the host of the site it came from. Not the console itself, and not the sign-in
 * provider a failed sign-in came back from (`?error=`). The server checks both and keeps them once, on a new account.
 */
export function signupSource(search: string, referrer: string, origin: string): SignupSource {
  const query = new URLSearchParams(search);
  const ref = query.get("ref") || undefined;
  let from: string | undefined;
  try {
    const url = new URL(referrer);
    if (/^https?:$/.test(url.protocol) && !query.has("error") && !(url.origin === origin && url.pathname.startsWith("/console"))) from = url.hostname;
  } catch { /* No referrer, or not an address. */ }
  return { ...(ref ? { ref } : {}), ...(from ? { from } : {}) };
}
