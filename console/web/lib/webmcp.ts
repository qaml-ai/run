import { z } from "zod";
import { Api } from "../../../packages/cli/src/api.ts";
import { errorText, resultText, tools, type ToolSpec } from "../../../packages/cli/src/tools.ts";

/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/): while someone is signed in to the console, the camelRun
 * tools (the same list as camelrun mcp and the hosted /mcp) are offered to the browser's agent. They run in the page,
 * as the signed-in person, through the console's own session. The spec puts `modelContext` on `document`; Chrome's
 * early builds have it on `navigator`, with `unregisterTool`. Without either, nothing happens.
 */
export interface ModelContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
}
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean };
  execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ content: { type: "text"; text: string }[]; isError?: true }>;
}

export function modelContext(): ModelContext | undefined {
  return (globalThis.document as any)?.modelContext ?? (globalThis.navigator as any)?.modelContext;
}

/** A tool as WebMCP registers it: its arguments as JSON Schema, checked again when called. */
export function webMcpTool(tool: ToolSpec): WebMcpTool {
  const input = z.object(tool.input);
  const readOnly = !!tool.annotations.readOnlyHint;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(input),
    // Anything that changes the account (or spends on a model) is consequential, so the browser may ask first.
    annotations: { readOnlyHint: readOnly, consequentialHint: !readOnly },
    async execute(raw) {
      try {
        const parsed = input.safeParse(raw ?? {});
        if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
        return { content: [{ type: "text", text: resultText(await tool.run(parsed.data)) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: errorText(error) }] };
      }
    },
  };
}

/** The console's API client: this origin, authenticated by the session cookie and the console header. */
export const consoleApi = () => new Api({ url: location.origin, headers: { "X-Agent-Runtime-Console": "1" } });

/**
 * Offer every tool to the browser's agent until `signal` aborts. Resolves with the names registered; a tool the
 * browser refuses is skipped (and logged), so one bad schema never hides the rest.
 */
export async function registerTools(signal: AbortSignal, context = modelContext(), api: () => Api = consoleApi): Promise<string[]> {
  if (!context || signal.aborted) return [];
  const registered: string[] = [];
  for (const tool of tools(api)) {
    try {
      await context.registerTool(webMcpTool(tool), { signal });
      registered.push(tool.name);
    } catch (error) {
      console.warn(`WebMCP: could not register ${tool.name}`, error);
    }
  }
  const unregister = () => { for (const name of registered) { try { context.unregisterTool?.(name); } catch { /* already gone */ } } };
  if (signal.aborted) unregister();
  else signal.addEventListener("abort", unregister, { once: true });
  return registered;
}
