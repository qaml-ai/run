import { authorize } from "@/lib/auth";
import { env } from "@/lib/env";
import { createAgentHandler } from "@camelai/run/server";
import { schema, tool } from "@camelai/run";

/**
 * The route the chat talks to. Your API key (CAMELRUN_API_KEY) stays on this server: browsers get
 * short-lived read-only tokens for their own agent, and everything they send goes through here, as
 * the user `authorize` returns.
 */
const handler = async () => {
  const e = await env();
  return createAgentHandler({
    apiKey: e.CAMELRUN_API_KEY || e.CAMELAI_API_KEY,
    url: e.CAMELRUN_URL || e.CAMELAI_BASE_URL || e.CAMELAI_URL,
    authorize,
    agent: {
      // No model: the agent gets your account's default. To choose one, set AGENT_MODEL to a model your account can
      // use (`npx -y @camelai/camelrun models --available`).
      ...(e.AGENT_MODEL ? { model: e.AGENT_MODEL } : {}),
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
};
let cached: ReturnType<typeof createAgentHandler> | undefined;
export async function POST(request: Request) { cached ??= await handler(); return cached(request); }
