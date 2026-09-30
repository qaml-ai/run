import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Agents, type Agent, type Run } from "@camelai/run";

const agents = new Agents();
const byUser = new Map<string, Promise<Agent>>(); // one durable agent per user, connected once
const running = new Map<string, Promise<Run>>(); // requestId -> its run, while this process streams it

function agentFor(user: string) {
  if (!byUser.has(user)) {
    byUser.set(user, agents.upsert(`server-hono-${user}`, {
      model: "openrouter/openai/gpt-6-luna",
      instructions: "You are a helpful, concise assistant.",
    }));
  }
  return byUser.get(user)!;
}

const app = new Hono();

// POST /chat {"user", "text", "requestId"}: the reply as SSE. The same requestId is the same run, so a retry never runs twice.
app.post("/chat", async (c) => {
  const { user, text, requestId } = await c.req.json();
  const agent = await agentFor(user);
  return streamSSE(c, async (sse) => {
    const send = (event: string, data: unknown) => sse.writeSSE({ event, data: JSON.stringify(data) });
    const done = (run: Run) => send("done", { status: run.status, text: run.text });
    try {
      // A retry while this process still streams the run: the SDK refuses a second wait (409), so wait on the first.
      if (running.has(requestId)) return void await done(await running.get(requestId)!);
      const stream = agent.stream(text, { user, idempotencyKey: requestId });
      const result = stream.result().finally(() => running.delete(requestId));
      result.catch(() => {}); // the loop below reports a failure
      running.set(requestId, result);
      for await (const part of stream) {
        if (part.type === "text") await send("text", part.text);
        if (part.type === "done") await done(part.run);
      }
    } catch (error) {
      await send("error", { message: String(error) });
    }
  });
});

serve({ fetch: app.fetch, port: 3000 }, () => console.log("listening on http://localhost:3000"));
