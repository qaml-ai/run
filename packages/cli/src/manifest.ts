import { parseAllDocuments, parse as parseYaml } from "yaml";

/**
 * An agent manifest (`agent.yaml`): one definition, deployed by its `key`, and optionally the keyed agents to
 * make from it. Everything but `key`, `agents` and `systemPromptFile` is sent as the definition, so the runtime
 * validates it (see docs/guides/definitions.md). Strings may name environment variables, `${NAME}` or
 * `${NAME:-default}`, to keep credentials out of the file. A file may hold several manifests as YAML documents.
 *
 * This module reads no files and no environment of its own, so it runs in browsers and in the hosted MCP server;
 * manifest-files.ts reads manifests from disk.
 */
export interface Manifest {
  key: string;
  definition: Record<string, unknown>;
  agents: ({ key: string } & Record<string, unknown>)[];
  file: string;
}

export const DEFAULT_FILES = ["agent.yaml", "agent.yml", "agent.json"];
const KEY = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Where a manifest's own files come from, and its environment. Without `readFile`, systemPromptFile and specFile
 * are refused; without `env`, every `${NAME}` is (`where` then says why).
 */
export interface ManifestSource { readFile?: (relativePath: string) => string; env?: Record<string, string | undefined>; noEnv?: string }

/** Manifests from YAML text (several documents are several manifests). */
export function parseManifests(text: string, where: string, source: ManifestSource = {}): Manifest[] {
  const documents = parseAllDocuments(text).map(document => {
    if (document.errors.length) throw new Error(`${where}: ${document.errors[0].message}`);
    return document.toJS();
  }).filter(document => document != null);
  return fromDocuments(documents, where, where, source);
}

/** Manifests from parsed documents, checked for keys used twice. */
export function fromDocuments(documents: unknown[], file: string, where: string, source: ManifestSource = {}): Manifest[] {
  if (!documents.length) throw new Error(`${where}: empty`);
  const manifests = documents.map((document, index) => {
    const at = documents.length > 1 ? `${where} (document ${index + 1})` : where;
    return parseManifest(interpolate(document, source.env ?? {}, source.env ? at : `${at}${source.noEnv ? ` (${source.noEnv})` : ""}`), file, at, source);
  });
  const keys = manifests.map(manifest => manifest.key);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated) throw new Error(`${where}: the key ${repeated} is used twice`);
  return manifests;
}

/** A manifest from its parsed document, with the files it names read through `source.readFile`. */
export function parseManifest(document: unknown, file: string, where = file, source: ManifestSource = {}): Manifest {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`${where}: a manifest is a mapping of fields`);
  const { key, agents = [], systemPromptFile, ...definition } = document as Record<string, any>;
  if (typeof key !== "string" || !KEY.test(key)) throw new Error(`${where}: key is required, 1 to 80 letters, digits, _ and - (the same key is the same definition)`);
  if (typeof definition.name !== "string" || !definition.name) definition.name = key;
  const read = (field: string, instead: string, path: string) => {
    if (!source.readFile) throw new Error(`${where}: a hosted deploy reads no files, so ${field} cannot be used; give ${instead}, or deploy with the camelrun CLI`);
    return source.readFile(path);
  };
  if (systemPromptFile !== undefined) {
    if (definition.systemPrompt !== undefined) throw new Error(`${where}: give systemPrompt or systemPromptFile, not both`);
    definition.systemPrompt = read("systemPromptFile", "systemPrompt", String(systemPromptFile)).trim();
  }
  if (Array.isArray(definition.openApi)) {
    definition.openApi = definition.openApi.map((openApi: any) => {
      if (!openApi || typeof openApi !== "object" || openApi.specFile === undefined) return openApi;
      const { specFile, ...rest } = openApi;
      if (rest.spec !== undefined) throw new Error(`${where}: an openApi source takes spec or specFile, not both`);
      const text = read("specFile", "spec", String(specFile));
      return { ...rest, spec: /\.json$/i.test(specFile) ? JSON.parse(text) : parseYaml(text) };
    });
  }
  if (!Array.isArray(agents)) throw new Error(`${where}: agents is a list of { key, … }`);
  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || typeof agent.key !== "string" || !KEY.test(agent.key)) throw new Error(`${where}: each agent needs a key, 1 to 80 letters, digits, _ and -`);
    if ("definition" in agent) throw new Error(`${where}: agent ${agent.key} is made from this manifest's definition; leave out definition`);
  }
  return { key, definition, agents, file };
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
  return `# An agent on camelRun. Deploy it with \`camelrun deploy\`; deploying again
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
