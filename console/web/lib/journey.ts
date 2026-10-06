/**
 * The console's pages, told to this runtime (`POST /api/journey/events`) where its operator turned journey
 * events on: the shell then carries a meta tag saying so, and without it nothing here runs. A page is sent
 * as its path; the runtime keeps only its route, and knows who is looking from the request, not from here.
 */
const ENDPOINT = "/api/journey/events";

async function send(event: object, attempts = 2): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", keepalive: true, credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1" },
        body: JSON.stringify({ schema_version: 1, events: [event] }),
      });
      // Anything but a fault of the runtime's is its answer: asking again would get the same.
      if (response.status < 500) return;
    } catch { /* Offline or interrupted: once more, with the same id. */ }
  }
}

/** Report this page, and each the console goes to. Returns how to stop. */
export function reportPages(): () => void {
  if (!document.querySelector('meta[name="agent-runtime-journey"]')) return () => {};
  let last: string | undefined;
  // Where the browser came from counts for the first page only; after that it came from the console.
  let referrer: string | null = null;
  try { referrer = document.referrer ? new URL(document.referrer).hostname.toLowerCase() : null; } catch { /* Not an address. */ }
  const view = () => {
    const path = location.pathname;
    if (path === last) return;
    last = path;
    void send({ event_id: crypto.randomUUID(), name: "page_viewed", occurred_at: new Date().toISOString(), page_path: path, referrer_host: referrer });
    referrer = null;
  };
  view();
  addEventListener("popstate", view);
  return () => removeEventListener("popstate", view);
}
