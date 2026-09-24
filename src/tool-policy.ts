import { Compile, type Validator } from "typebox/compile";
import type { ToolDefinition } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";

export function validateDefinitions(definitions: ToolDefinition[]) {
  if (!Array.isArray(definitions)) throw new Error("Tool definitions must be an array");
  if (definitions.length > 128) throw new Error("Too many tool definitions");
  jsonWithinLimit(definitions, 256 * 1024, "Tool catalog");
  const names = new Set<string>();
  for (const tool of definitions) {
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" ||
      !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error("Invalid tool definition");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool.name) ||
      ["js_exec", "then", "constructor", "prototype", "search", "describe"].includes(tool.name) || names.has(tool.name)) {
      throw new Error(`Invalid, duplicate, or reserved tool name: ${tool.name}`);
    }
    if (tool.exposure !== undefined && !["direct", "codemode", "both"].includes(tool.exposure)) throw new Error("Invalid tool exposure");
    if (tool.executionMode !== undefined && !["sequential", "parallel"].includes(tool.executionMode)) throw new Error("Invalid tool execution mode");
    if (tool.resultFormat !== undefined && !["json", "content"].includes(tool.resultFormat)) throw new Error("Invalid tool result format");
    names.add(tool.name);
  }
}

/** Compiled once per schema object: a tool's definition stays the same object for as long as the agent runs. */
const validators = new WeakMap<object, Validator>();
function validator(schema: object) {
  let compiled = validators.get(schema);
  if (!compiled) validators.set(schema, compiled = Compile(schema as never));
  return compiled;
}

/** Whether arguments can be checked against `schema`: a schema from outside (an MCP server) may not compile. */
export function compiles(schema: object) {
  try { validator(schema); return true; } catch { return false; }
}

export function validateToolCall(definitions: ToolDefinition[], name: unknown, args: unknown) {
  const tool = definitions.find(tool => tool.name === name);
  if (!tool) throw new Error("Unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
  const json = jsonWithinLimit(args, SANDBOX_LIMITS.argumentBytes, "Tool arguments");
  if (!validator(tool.parameters).Check(args)) throw new Error(`Invalid arguments for tool: ${tool.name}`);
  return { tool, args: args as Record<string, unknown>, bytes: Buffer.byteLength(json) };
}
