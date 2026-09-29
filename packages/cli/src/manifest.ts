import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parseAllDocuments, parse as parseYaml } from "yaml";

/**
 * An agent manifest (`agent.yaml`): one definition, deployed by its `key`, and optionally the keyed agents to
 * make from it. Everything but `key`, `agents` and `systemPromptFile` is sent as the definition, so the runtime
 * validates it (see docs/guides/definitions.md). Strings may name environment variables, `${NAME}` or
 * `${NAME:-default}`, to keep credentials out of the file. A file may hold several manifests as YAML documents.
 */
export interface Manifest {
  key: string;
  definition: Record<string, unknown>;
  agents: ({ key: string } & Record<string, unknown>)[];
  file: string;
}

export const DEFAULT_FILES = ["agent.yaml", "agent.yml", "agent.json"];
const KEY = /^[A-Za-z0-9_-]{1,80}$/;

export function findManifest(cwd = process.cwd()) {
  const found = DEFAULT_FILES.map(name => resolve(cwd, name)).find(path => existsSync(path));
  if (!found) throw new Error(`No manifest: expected one of ${DEFAULT_FILES.join(", ")} here, or pass a path (camelrun init writes one)`);
  return found;
}

export function loadManifests(file: string, env: Record<string, string | undefined> = process.env): Manifest[] {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`${file}: no such file`);
  const text = readFileSync(path, "utf8");
  const documents = extname(path) === ".json" ? [JSON.parse(text)] : parseAllDocuments(text).map(document => {
    if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);
    return document.toJS();
  }).filter(document => document != null);
  if (!documents.length) throw new Error(`${file}: empty`);
  const manifests = documents.map((document, index) => parseManifest(interpolate(document, env, file), path, documents.length > 1 ? `${file} (document ${index + 1})` : file));
  const keys = manifests.map(manifest => manifest.key);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated) throw new Error(`${file}: the key ${repeated} is used twice`);
  return manifests;
}

/** A manifest from its parsed document, with files it names read relative to it. */
export function parseManifest(document: unknown, path: string, where = path, options: { files?: boolean } = {}): Manifest {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${where}: a manifest is a mapping of fields`);
  const { key, agents = [], systemPromptFile, ...definition } = document as Record<string, any>;
  if (typeof key !== "string" || !KEY.test(key)) throw new Error(`${where}: key is required, 1 to 80 letters, digits, _ and - (the same key is the same definition)`);
  if (typeof definition.name !== "string" || !definition.name) definition.name = key;
  const base = dirname(path);
  const noFiles = (field: string, instead: string) => { if (options.files === false) throw new Error(`${where}: a hosted deploy reads no files, so ${field} cannot be used; give ${instead}, or deploy with the camelrun CLI`); };
  if (systemPromptFile !== undefined) {
    noFiles("systemPromptFile", "systemPrompt");
    if (definition.systemPrompt !== undefined) throw new Error(`${where}: give systemPrompt or systemPromptFile, not both`);
    definition.systemPrompt = readFileSync(resolve(base, String(systemPromptFile)), "utf8").trim();
  }
  if (Array.isArray(definition.openApi)) {
    definition.openApi = definition.openApi.map((source: any) => {
      if (!source || typeof source !== "object" || source.specFile === undefined) return source;
      noFiles("specFile", "spec");
      const { specFile, ...rest } = source;
      if (rest.spec !== undefined) throw new Error(`${where}: an openApi source takes spec or specFile, not both`);
      const text = readFileSync(resolve(base, String(specFile)), "utf8");
      return { ...rest, spec: /\.json$/i.test(specFile) ? JSON.parse(text) : parseYaml(text) };
    });
  }
  if (!Array.isArray(agents)) throw new Error(`${where}: agents is a list of { key, … }`);
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.key !== "string" || !KEY.test(agent.key)) throw new Error(`${where}: each agent needs a key, 1 to 80 letters, digits, _ and -`);
    if ("definition" in agent) throw new Error(`${where}: agent ${agent.key} is made from this manifest's definition; leave out definition`);
  }
  return { key, definition, agents, file: path };
}

/** Replace `${NAME}` and `${NAME:-default}` in every string; `$${…}` is left as `${…}`. */
export function interpolate(value: unknown, env: Record<string, string | undefined>, where: string): any {
  if (typeof value === "string") {
    return value.replace(/\$(\$)?\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, escaped, name, fallback) => {
      if (escaped) return match.slice(1);
      const found = env[name] ?? fallback;
      if (found === undefined) throw new Error(`${where}: \${${name}} is not set`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map(item => interpolate(item, env, where));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env, where)]));
  return value;
}

export function template(key: string, model?: string) {
  return `# An agent on the camelAI agent runtime. Deploy it with \`camelrun deploy\`; deploying again
# updates the definition in place (the same key is the same definition).
# Fields: https://agents.camelai.dev/docs/guides/definitions.md
key: ${key}
name: ${key}
${model ? `model: ${model}` : "# model: anthropic/claude-sonnet-5-5   # camelrun models --available lists yours"}
systemPrompt: |
  You are a helpful assistant. Be concise.
# systemPromptFile: prompts/${key}.md   # or keep the prompt in its own file
# thinkingLevel: low
builtins: [web_fetch, web_search]
# Remote tools. Strings can read environment variables, so credentials stay out of the file.
# mcpServers:
#   - name: app
#     url: https://app.example.com/mcp
#     auth: { type: bearer, token: "\${APP_MCP_TOKEN}" }
# openApi:
#   - name: billing
#     specFile: openapi.yaml
#     auth: { type: runtime }
# Keyed agents to make from this definition on deploy (they live until deleted).
agents:
  - key: ${key}
`;
}
