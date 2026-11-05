// Dedicated experiment: actual CamelAgent, no database or provider binding.
// Only configuration, live stream and state are exposed; it cannot run prompts.
import { CamelAgent, type Env } from "../../src/agent.ts";
import { websocketAuthorization } from "../../src/live-transport.ts";
export { CamelAgent };

interface ProbeEnv extends Env { PROBE_TOKEN: string }
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    request = websocketAuthorization(request);
    if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (!["/initialize", "/events", "/state", "/meta"].includes(url.pathname)) return new Response("Not found", { status: 404 });
    const name = url.searchParams.get("agent") ?? "idle-websocket";
    if (!/^[a-z-]{1,40}$/.test(name)) return new Response("Invalid name", { status: 400 });
    const agent = env.AGENTS.getByName(name);
    if (url.pathname === "/meta") return Response.json({ objectId: agent.id.toString(), name });
    if (url.pathname === "/initialize") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      url.pathname = "/configuration";
      return agent.fetch(new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        id: name, tenantId: "synthetic-hibernation-fixture", revision: 1, expiresAt: null,
        config: { model: "test/echo", codeMode: false, fileTools: false },
      }) }));
    }
    return agent.fetch(new Request(url, request));
  },
};
