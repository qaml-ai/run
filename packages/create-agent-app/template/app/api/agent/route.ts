import { cookies } from "next/headers";
import { createAgentHandler } from "@camelai/agent-runtime/server";
import { schema, tool } from "@camelai/agent-runtime";

/**
 * The route the chat talks to. Your API key (CAMELAI_API_KEY) stays on this server: browsers get
 * short-lived read-only tokens for their own agent, and everything they send goes through here, as
 * the user `authorize` returns.
 */
export const POST = createAgentHandler({
  authorize: async () => {
    // Your sign-in goes here: return { userId, name } for a signed-in user, or null (401).
    const userId = (await cookies()).get("demo_user")?.value;
    return userId ? { userId } : null;
  },
  agent: {
    instructions: "You are a friendly assistant in a demo app. Keep answers short. Use get_weather when asked about the weather.",
    // Tools run here, in this server, while `next dev` or `next start` runs. For serverless hosting,
    // serve them with serveTools and a definition instead (see the README).
    tools: {
      get_weather: tool({
        description: "The current weather in a city",
        input: schema.Object({ city: schema.String() }),
        execute: async ({ city }) => {
          // Swap in a real weather API. This one is made up, so the demo needs no other key.
          const seed = [...city].reduce((sum, char) => sum + char.charCodeAt(0), 0);
          return { city, temperatureC: 8 + (seed % 22), conditions: ["Sunny", "Cloudy", "Rain", "Windy"][seed % 4] };
        },
      }),
    },
  },
});
