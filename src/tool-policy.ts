import { Compile, type Validator } from "typebox/compile";
import type { ToolDefinition } from "./protocol.ts";
import { CATALOG_LIMITS, jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { inputSignature } from "./tool-search.ts";

/** Catalogs already checked: one is checked again at every js_exec, and large ones are not free to check. */
const validated = new WeakSet<ToolDefinition[]>();

export function validateDefinitions(definitions: ToolDefinition[]) {
  if (!Array.isArray(definitions)) throw new Error("Tool definitions must be an array");
  if (validated.has(definitions)) return;
  if (definitions.length > CATALOG_LIMITS.tools) throw new Error(`Too many tool definitions (at most ${CATALOG_LIMITS.tools})`);
  jsonWithinLimit(definitions, CATALOG_LIMITS.bytes, "Tool catalog");
  const names = new Set<string>();
  for (const tool of definitions) {
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" ||
      !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error("Invalid tool definition");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool.name) ||
      ["js_exec", "then", "constructor", "prototype", "search", "describe", "namespaces"].includes(tool.name) || names.has(tool.name)) {
      throw new Error(`Invalid, duplicate, or reserved tool name: ${tool.name}`);
    }
    if (tool.exposure !== undefined && !["direct", "codemode", "both"].includes(tool.exposure)) throw new Error("Invalid tool exposure");
    if (tool.executionMode !== undefined && !["sequential", "parallel"].includes(tool.executionMode)) throw new Error("Invalid tool execution mode");
    if (tool.resultFormat !== undefined && !["json", "content"].includes(tool.resultFormat)) throw new Error("Invalid tool result format");
    names.add(tool.name);
  }
  validated.add(definitions);
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

/** Whether `value` fits `schema` (a form an MCP tool asked the user to fill in). */
export function schemaAccepts(schema: object, value: unknown) {
  try { return validator(schema).Check(value); } catch { return false; }
}

const indexes = new WeakMap<ToolDefinition[], Map<string, ToolDefinition>>();

export function validateToolCall(definitions: ToolDefinition[], name: unknown, args: unknown) {
  let index = indexes.get(definitions);
  if (!index) indexes.set(definitions, index = new Map(definitions.map(tool => [tool.name, tool])));
  const tool = typeof name === "string" ? index.get(name) : undefined;
  if (!tool) throw new Error("Unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
  const json = jsonWithinLimit(args, SANDBOX_LIMITS.argumentBytes, "Tool arguments");
  const check = validator(tool.parameters);
  if (!check.Check(args)) {
    // Say what is wrong and what the tool takes, so the next call can be right without tools.describe.
    const problems = [...check.Errors(args)].slice(0, 3).map(error => `${error.instancePath || "arguments"} ${error.message}${error.keyword === "additionalProperties" ? ` (${(error.params as { additionalProperties?: string[] }).additionalProperties?.join(", ")})` : ""}`);
    throw new Error(`Invalid arguments for tool: ${tool.name}: ${problems.join("; ")}. It takes ${inputSignature(tool.parameters)}`);
  }
  return { tool, args: args as Record<string, unknown>, bytes: Buffer.byteLength(json) };
}
