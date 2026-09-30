import { Hono } from "hono";
import { createAgentHandler } from "@camelai/run/server";

const handler = createAgentHandler({
  // The browser reads its agent through this route too, and never talks to the runtime itself.
  proxy: true,
  // Demo sign-in: the browser names its user. Replace with your own auth (a session cookie, a JWT).
  authorize: request => {
    const userId = request.headers.get("x-demo-user");
    return userId ? { userId } : null;
  },
  // model is optional: any model from GET /v1/models?available=true (the runtime's default otherwise).
  agent: { instructions: "You are a helpful assistant. Keep answers short.", model: process.env.CAMELAI_MODEL },
});

// The route and every path under it (the proxied reads).
const app = new Hono();
app.all("/api/agent", c => handler(c.req.raw));
app.all("/api/agent/*", c => handler(c.req.raw));
export default app;
