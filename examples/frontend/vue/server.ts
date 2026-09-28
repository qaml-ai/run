import express from "express";
import { createServer } from "vite";
import { createAgentHandler } from "@camelai/agent-runtime/server";
import { nodeListener } from "@camelai/agent-runtime/node";

const handler = createAgentHandler({
  // Demo sign-in: the browser names its user. Replace with your own auth (a session cookie, a JWT).
  authorize: request => {
    const userId = request.headers.get("x-demo-user");
    return userId ? { userId } : null;
  },
  // model is optional: any model from GET /v1/models?available=true (the runtime's default otherwise).
  agent: { instructions: "You are a helpful assistant. Keep answers short.", model: process.env.CAMELAI_MODEL },
});

const app = express();
app.post("/api/agent", nodeListener(handler));
app.use((await createServer({ server: { middlewareMode: true }, appType: "spa" })).middlewares);
app.listen(3000, () => console.log("http://localhost:3000"));
