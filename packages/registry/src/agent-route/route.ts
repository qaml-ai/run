import { createAgentHandler } from "@camelai/run/server";

/**
 * The route <AgentChat endpoint="/api/agent" /> talks to. Your API key (CAMELAI_API_KEY) stays here;
 * browsers get short-lived read-only tokens for their user's own agent, and every message is sent as
 * the user `authorize` returns.
 */
export const POST = createAgentHandler({
  authorize: async () => {
    // Replace with your own session check (Clerk, Auth.js, your cookie…): return { userId, name } or null.
    // Until then: one shared demo user, in development only.
    return process.env.NODE_ENV === "production" ? null : { userId: "demo", name: "Demo user" };
  },
  agent: {
    instructions: "You are a helpful assistant.",
  },
});
