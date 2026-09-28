import express from "express";
import { createServer } from "vite";
import { createAgentHandler } from "@camelai/agent-runtime/server";
import { nodeListener } from "@camelai/agent-runtime/node";
import { schema, tool } from "@camelai/agent-runtime";

const handler = createAgentHandler({
  // Demo sign-in: the browser names its user. Replace with your own auth (a session cookie, a JWT).
  authorize: request => {
    const userId = request.headers.get("x-demo-user");
    return userId ? { userId } : null;
  },
  agent: {
    instructions: "You are a helpful assistant. Keep answers short. Use get_weather for the weather.",
    model: process.env.CAMELAI_MODEL, // optional: any model from GET /v1/models?available=true
    tools: {
      get_weather: tool({
        description: "The current weather in a city",
        input: schema.Object({ city: schema.String() }),
        execute: async ({ city }) => ({ city, temperatureC: 12 + (city.length * 7) % 18, conditions: "Sunny" }),
      }),
    },
  },
});

const app = express();
app.post("/api/agent", nodeListener(handler));
app.use((await createServer({ server: { middlewareMode: true }, appType: "spa" })).middlewares);
app.listen(3000, () => console.log("http://localhost:3000"));
