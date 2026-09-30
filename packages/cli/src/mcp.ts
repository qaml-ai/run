import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Api } from "./api.ts";
import { findManifest, loadManifests } from "./manifest-files.ts";
import { errorText, INSTRUCTIONS, resultText, tools } from "./tools.ts";
import { VERSION } from "./version.ts";
import { readFileSync } from "node:fs";

/** A result's most characters: past it the rest is cut, so one long history or spec cannot fill a model's context. */
export const MAX_RESULT = 100_000;
const capped = (text: string) => text.length <= MAX_RESULT ? text : `${text.slice(0, MAX_RESULT)}\n\n[Cut at ${MAX_RESULT} characters of ${text.length}: ask for less, such as a smaller limit.]`;

/** Serve the CLI's operations as MCP tools over stdio. Credentials are read on each call, so a login takes effect at once. */
export async function serve(api: () => Api, options: { cwd: string }) {
  const server = createServer(api, options);
  // The transport does not notice its client going away: stdin ending is that.
  const closed = new Promise<void>(resolve => { server.server.onclose = resolve; process.stdin.once("end", resolve); });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close();
}

/**
 * The tools (tools.ts) as an MCP server, for `api`. With `cwd` it runs on the user's machine: deploy reads manifests
 * and the files they name, and `${NAME}` reads the environment. Without it (the runtime's hosted /mcp), deploy takes
 * the manifest's YAML only, and reads no file and no environment variable of the server's.
 */
export function createServer(api: () => Api, options: { cwd?: string } = {}) {
  const { cwd } = options;
  const server = new McpServer({ name: "camelrun", title: "camelRun", version: VERSION }, { instructions: INSTRUCTIONS });
  const local = cwd === undefined ? undefined : {
    env: process.env,
    readFile: (path: string) => readFileSync(resolve(cwd, path), "utf8"),
    load: (file?: string) => loadManifests(file ? (isAbsolute(file) ? file : resolve(cwd, file)) : findManifest(cwd)),
  };
  for (const tool of tools(api, { local })) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...tool.annotations } }, (async (args: any) => {
      try { return { content: [{ type: "text", text: capped(resultText(await tool.run(args))) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text", text: errorText(error) }] }; }
    }) as any);
  }
  return server;
}
