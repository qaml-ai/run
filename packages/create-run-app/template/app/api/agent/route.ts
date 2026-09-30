import { cookies } from "next/headers";
import { createAgentHandler } from "@camelai/run/server";
import { schema, tool } from "@camelai/run";

/**
 * The route the chat talks to. Your API key (CAMELAI_API_KEY) stays on this server: browsers get
 * short-lived read-only tokens for their own agent, and everything they send goes through here, as
 * the user `authorize` returns.
 */
export const POST = createAgentHandler({
  authorize: async () => {
    // ⚠ A DEMO SIGN-IN: anyone with a browser is a user. Replace this with your own (Clerk, Auth.js,
    // your session) and return { userId, name } for a signed-in user, or null.
    // Deployed (production), it refuses everyone unless you opt in with DEMO_AUTH=1.
    if (process.env.NODE_ENV === "production" && process.env.DEMO_AUTH !== "1") {
      throw Response.json({ error: { code: "unauthorized", message: "This app has no sign-in yet: add your own in app/api/agent/route.ts (or set DEMO_AUTH=1 to allow anonymous demo users)." } }, { status: 401 });
    }
    const userId = (await cookies()).get("demo_user")?.value;
    return userId && /^[0-9a-f-]{36}$/.test(userId) ? { userId } : null;
  },
  agent: {
    // Any model in GET /v1/models your account can use (?available=true): prepaid credit, or your own key for its provider.
    model: process.env.AGENT_MODEL ?? "openrouter/anthropic/claude-sonnet-5.5",
    instructions: "You are a friendly assistant in a demo app. Keep answers short. Use get_weather when asked about the weather.",
    // Tools run here, in this server, while `next dev` or `next start` runs. For serverless hosting,
    // serve them with serveTools and a definition instead (see the README).
    tools: {
      get_weather: tool({
        description: "The current weather in a city",
        input: schema.Object({ city: schema.String({ maxLength: 100 }) }),
        execute: async ({ city }) => {
          // Swap in a real weather API. This one is made up, so the demo needs no other key.
          const seed = [...city].reduce((sum, char) => sum + char.charCodeAt(0), 0);
          return { city, temperatureC: 8 + (seed % 22), conditions: ["Sunny", "Cloudy", "Rain", "Windy"][seed % 4] };
        },
      }),
    },
  },
});
