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
    if (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1_000 || tool.timeoutMs > 1_200_000)) throw new Error("Invalid tool timeoutMs");
    names.add(tool.name);
  }
  validated.add(definitions);
}

/** Compiled once per schema object: a tool's definition stays the same object for as long as the agent runs. */
const validators = new WeakMap<object, Validator>();
function validator(schema: object) {
  let compiled = validators.get(schema);
  if (!compiled) validators.set(schema, compiled = Compile(checkable(schema) as never));
  return compiled;
}

/** Keywords whose value is a schema, or an array of them. */
const SUBSCHEMAS = new Set(["items", "additionalItems", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf"]);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

/**
 * A schema as the runtime checks it: without `pattern` and `patternProperties`. Their regular
 * expressions are the tenant's, matched here against arguments a model or guest code wrote, and one
 * that backtracks takes minutes on a short string (V8's linear-time engine does not take the `u` flag
 * JSON Schema patterns use). Without patternProperties, an object's other properties are let through
 * too (its additionalProperties and unevaluatedProperties go): the check only loosens. A tool gets
 * arguments of its declared shape still, and checks its own patterns. `const`, `enum`, `default` and
 * the like are data, kept as they are.
 */
export function checkable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(checkable);
  if (!schema || typeof schema !== "object") return schema;
  const patterned = "patternProperties" in schema;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Compiled (in linear time), never run: a schema with one that does not compile is still refused.
    if (key === "pattern" && typeof value === "string") new RegExp(value, "u");
    if (key === "patternProperties" && value && typeof value === "object") for (const name of Object.keys(value)) new RegExp(name, "u");
    if (key === "pattern" || key === "patternProperties" || (patterned && (key === "additionalProperties" || key === "unevaluatedProperties"))) continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) kept[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, checkable(entry)]));
    else kept[key] = SUBSCHEMAS.has(key) ? checkable(value) : value;
  }
  return kept;
}

/** Arguments larger than this get no per-field account of what is wrong: working one out can take quadratic time (typebox's uniqueItems). */
const DETAILED_ERROR_BYTES = 16 * 1024;

/** Whether arguments can be checked against `schema`: a schema from outside (an MCP server) may not compile. */
export function compiles(schema: object) {
  try { validator(schema); return true; } catch { return false; }
}

/** The largest output schema a prompt may give, as JSON. */
export const OUTPUT_SCHEMA_BYTES = 64 * 1024;

/**
 * A prompt's `output`: `{ schema }`, a JSON Schema for an object (the arguments of the final_output tool the
 * model answers with) that compiles. Its `$schema` is dropped: providers take tool schemas without one.
 */
export function outputInput(value: unknown): { schema: Record<string, unknown> } {
  const invalid = () => new Error("output is { schema }, a JSON Schema for an object");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { schema, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || !schema || typeof schema !== "object" || Array.isArray(schema)) throw invalid();
  const { $schema: _dialect, ...parameters } = schema as Record<string, unknown>;
  if (parameters.type !== "object") throw new Error("output.schema must describe an object (type: \"object\"); wrap anything else in one");
  jsonWithinLimit(parameters, OUTPUT_SCHEMA_BYTES, "output.schema");
  if (!compiles(parameters)) throw new Error("output.schema is not a JSON Schema the runtime can check");
  return { schema: parameters };
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
    if (json.length > DETAILED_ERROR_BYTES) throw new Error(`Invalid arguments for tool: ${tool.name}. It takes ${inputSignature(tool.parameters)}`);
    // Say what is wrong and what the tool takes, so the next call can be right without tools.describe.
    const problems = [...check.Errors(args)].slice(0, 3).map(error => `${error.instancePath || "arguments"} ${error.message}${error.keyword === "additionalProperties" ? ` (${(error.params as { additionalProperties?: string[] }).additionalProperties?.join(", ")})` : ""}`);
    throw new Error(`Invalid arguments for tool: ${tool.name}: ${problems.join("; ")}. It takes ${inputSignature(tool.parameters)}`);
  }
  return { tool, args: args as Record<string, unknown>, bytes: Buffer.byteLength(json) };
}
