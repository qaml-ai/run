import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { Agent } from "@camelai/run";
import type { Projects } from "./projects.ts";

export const PORT = Number(process.env.PORT ?? 3000);
/** Where this app is reached: camelRun calls `<PUBLIC_URL>/mcp` when set, and the model hands out links under it. */
export const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");
export const BASE_URL = PUBLIC_URL ?? `http://localhost:${PORT}`;
export const DATA_DIR = process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname;

/**
 * Serve the app (and, with PUBLIC_URL, its tools at /mcp), open the project's agent, and talk to it from the
 * terminal: each line is a message, and you see its reply and its tool calls as they stream.
 */
export async function start(app: Hono, projects: Projects, project: string) {
  if (PUBLIC_URL) {
    const tools = await projects.mcpHandler();
    app.all("/mcp", c => tools(c.req.raw));
  }
  serve({ fetch: app.fetch, port: PORT });
  const agent = await projects.open(project);
  console.log(`Published versions: ${BASE_URL}/  ·  project "${project}"  ·  type a request (Ctrl-D to quit)`);
  const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: `${project}> ` });
  lines.prompt();
  for await (const line of lines) {
    if (line.trim()) await send(agent, line);
    lines.prompt();
  }
  await projects.options.agents.close();
  process.exit(0);
}

async function send(agent: Agent, text: string) {
  for await (const part of agent.stream(text)) {
    if (part.type === "text") process.stdout.write(part.text);
    if (part.type === "tool_call") console.log(`\n→ ${part.tool} ${summary(part.arguments)}`);
    if (part.type === "tool_result" && part.tool.endsWith("publish")) console.log(`← ${part.output.slice(0, 400)}`);
    if (part.type === "done" && part.run.error) console.log(`\n[${part.run.error.code}] ${part.run.error.message}`);
  }
  console.log();
}

const summary = (args: unknown) => {
  const { path, pattern } = (args ?? {}) as { path?: string; pattern?: string };
  return path ?? pattern ?? "";
};

/** Escape text for HTML. */
export const html = (value: unknown) => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** The viewer's page frame. */
export const page = (title: string, body: string, head = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>${head}
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px; color: #1d1d1f; }
  a { color: #0b63ce; } h1 { font-size: 22px; margin: 0 0 16px; } table { border-collapse: collapse; }
  td, th { padding: 4px 12px 4px 0; text-align: left; } .muted { color: #6e6e73; }
  iframe { width: 100%; height: 70vh; border: 1px solid #d2d2d7; border-radius: 8px; }
</style></head><body>${body}</body></html>`;
